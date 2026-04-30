const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { TASKS } = require("./agent/tasks");
const { evaluateSubmission } = require("./agent/verdictEngine");
const { MemoryStore } = require("./storage/memoryStore");
const { NvidiaProvider } = require("./providers/nvidia");
const { BitdeerProvider } = require("./providers/bitdeer");
const { AsrProvider } = require("./providers/asr");
const { HermesProvider } = require("./providers/hermes");
const {
  aggregateVisualSignals,
  mergeSignals,
  parseAsrEvidence,
  parseVisualObservationEvidence,
  parseVisionComplianceEvidence
} = require("./agent/modelSignals");

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const app = express();
const port = Number(process.env.PORT || 3100);
const store = new MemoryStore(TASKS, { filePath: path.join(__dirname, "..", "data", "store.json") });
const nvidia = new NvidiaProvider();
const bitdeer = new BitdeerProvider();
const asr = new AsrProvider();
const hermes = new HermesProvider();

app.use(express.json({ limit: "16mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    service: "hermes-data-quality-agent",
    hermes: hermes.describe(),
    nvidia: nvidia.describe(),
    bitdeer: bitdeer.describe(),
    asr: asr.describe()
  });
});

app.get("/api/tasks", (_, res) => {
  res.json({ tasks: store.listTasks() });
});

app.post("/api/tasks", (req, res) => {
  try {
    const task = buildCustomTask(req.body || {});
    const created = store.addTask(task);
    res.status(201).json({ ok: true, task: created, tasks: store.listTasks() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/hermes/plan-task", async (req, res) => {
  try {
    const description = String(req.body?.description || "").trim();
    if (!description) {
      return res.status(400).json({ ok: false, error: "description is required" });
    }

    const plan = await hermes.planTask(description);
    return res.json({ ok: true, plan });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/submissions", (_, res) => {
  res.json({ submissions: store.listSubmissions(), summary: store.summary() });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { taskId, file, metrics, reviewerSignals, evidence } = req.body || {};
    if (!file || !metrics || !taskId) {
      return res.status(400).json({ ok: false, error: "taskId, file, and metrics are required" });
    }

    const task = store.getTask(taskId);
    if (!task) {
      return res.status(404).json({ ok: false, error: "Task not found. Create a collection task first." });
    }
    const previousHashes = store.hashesForTask(task.id);
    const preVerdictEvidence = await collectPreVerdictEvidence({
      task,
      metrics,
      evidence: evidence || {}
    });
    const modelSignals = deriveModelSignals(preVerdictEvidence, task, metrics);
    const combinedReviewerSignals = mergeSignals(reviewerSignals || {}, modelSignals);
    const result = evaluateSubmission({
      task,
      metrics,
      previousHashes,
      reviewerSignals: combinedReviewerSignals
    });

    const nvidiaEvidence = await collectPostVerdictEvidence({
      task,
      file,
      metrics,
      evidence: evidence || {},
      verdict: result,
      modelSignals
    });
    const modelEvidence = [...preVerdictEvidence, ...nvidiaEvidence];
    insertEvidenceTimeline(result.timeline, modelEvidence);
    if (Object.keys(modelSignals.semantic || {}).length > 0) {
      result.timeline.splice(-1, 0, "Applied model-derived task signals");
    }
    const hermesReview = await safeHermesReview({
      task,
      file,
      metrics,
      verdict: result,
      modelSignals
    });
    refineHermesFeedback({ task, result, modelSignals, hermesReview });
    applyHermesRouting({ result, task, hermesReview });
    result.timeline.splice(-1, 0, hermesReview.ok ? "Hermes generated reviewer brief" : "Hermes review unavailable");

    const submission = store.addSubmission({
      task,
      file,
      metrics,
      reviewerSignals: combinedReviewerSignals,
      modelSignals,
      nvidiaEvidence: modelEvidence,
      hermesReview,
      ...result
    });

    return res.json({ ok: true, submission, summary: store.summary() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/submissions/:id/review", (req, res) => {
  const updated = store.updateReview(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ ok: false, error: "Submission not found" });
  return res.json({ ok: true, submission: updated, summary: store.summary() });
});

app.delete("/api/submissions/:id", (req, res) => {
  const removed = store.deleteSubmission(req.params.id);
  if (!removed) return res.status(404).json({ ok: false, error: "Submission not found" });
  return res.json({ ok: true, removedId: removed.id, summary: store.summary() });
});

app.post("/api/nvidia/explain", async (req, res) => {
  try {
    const result = await nvidia.explainVerdict(req.body || {});
    res.json({ ok: true, nvidia: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

async function collectPreVerdictEvidence({ task, metrics, evidence }) {
  const results = [];

  if (bitdeer.enabled()) {
    const visualEvidence = normalizeVisualEvidence(evidence);
    const visualResults = await Promise.all(
      visualEvidence.flatMap((item) => [
        {
          kind: "visual_observation",
          segment: item.label,
          model: bitdeer.visionModel,
          run: () =>
            bitdeer.describeFrame({
              metrics,
              imageDataUrl: item.imageDataUrl,
              contextLabel: item.label
            })
        },
        {
          kind: "vision_compliance",
          segment: item.label,
          model: bitdeer.visionModel,
          run: () =>
            bitdeer.evaluateFrame({
              task,
              metrics,
              imageDataUrl: item.imageDataUrl,
              contextLabel: item.label
            })
        }
      ]).map(async (item) => ({
        kind: item.kind,
        segment: item.segment,
        model: item.model,
        result: await safeEvidenceCall(item.run)
      }))
    );
    results.push(...visualResults);
  }

  if (asr.enabled() && evidence.asrAudioDataUrl) {
    results.push({
      kind: "asr_transcript",
      model: asr.model,
      result: await safeEvidenceCall(() => asr.transcribeDataUrl(evidence.asrAudioDataUrl))
    });
  }

  return results;
}

function insertEvidenceTimeline(timeline, modelEvidence) {
  if (!Array.isArray(modelEvidence) || modelEvidence.length === 0) return;
  const kinds = new Set(modelEvidence.map((item) => item.kind));
  const steps = [];
  if (kinds.has("visual_observation")) steps.push("Ran task-agnostic visual observation");
  if (kinds.has("vision_compliance")) steps.push("Ran vision task compliance");
  if (kinds.has("asr_transcript")) steps.push("Ran NVIDIA Parakeet ASR");
  if (kinds.has("content_safety")) steps.push("Ran NVIDIA content safety");
  if (kinds.has("pii")) steps.push("Ran NVIDIA PII scan");
  if (kinds.has("policy_review")) steps.push("Ran NVIDIA policy reasoning");
  for (const step of steps) timeline.splice(-1, 0, step);
}

function normalizeVisualEvidence(evidence = {}) {
  const items = [];
  if (evidence.sampleImageDataUrl) {
    items.push({
      label: "overview contact sheet",
      imageDataUrl: evidence.sampleImageDataUrl
    });
  }

  const maxSegments = Math.max(0, Number(process.env.MAX_VISION_SEGMENTS || 3));
  const segments = Array.isArray(evidence.segmentImageDataUrls)
    ? evidence.segmentImageDataUrls.slice(0, maxSegments)
    : [];
  for (const [index, segment] of segments.entries()) {
    if (typeof segment === "string") {
      items.push({
        label: `video segment ${index + 1}`,
        imageDataUrl: segment
      });
    } else if (segment?.imageDataUrl) {
      items.push({
        label: segment.label || `video segment ${index + 1}`,
        imageDataUrl: segment.imageDataUrl
      });
    }
  }

  return items;
}

async function collectPostVerdictEvidence({ task, file, metrics, evidence, verdict, modelSignals }) {
  const results = [];
  const transcript = evidence.transcript || modelSignals?.transcript;

  if (nvidia.isConfigured("safety") && evidence.sampleImageDataUrl) {
    results.push({
      kind: "content_safety",
      model: nvidia.models.safety,
      result: await safeEvidenceCall(() =>
        nvidia.checkContentSafety({
          text: `Dataset task: ${task.objective}. File: ${file.name}. Metrics: ${JSON.stringify(metrics)}`,
          imageDataUrl: evidence.sampleImageDataUrl
        })
      )
    });
  }

  if (nvidia.isConfigured("pii") && transcript) {
    results.push({
      kind: "pii",
      model: nvidia.models.pii,
      result: await safeEvidenceCall(() => nvidia.detectPii(transcript))
    });
  }

  if (nvidia.isConfigured("policy")) {
    results.push({
      kind: "policy_review",
      model: nvidia.models.policy,
      result: await safeEvidenceCall(() => nvidia.explainVerdict({ task, metrics, verdict }))
    });
  }

  return results;
}

function deriveModelSignals(evidenceItems, task, metrics = {}) {
  const signals = [];
  const visualSignals = [];
  const visualObservations = [];

  for (const item of evidenceItems) {
    if (item.kind === "visual_observation") {
      const parsed = parseVisualObservationEvidence(item.result);
      if (item.segment && Array.isArray(parsed.notes)) {
        parsed.notes.unshift(`Visual observation: ${item.segment}`);
      }
      visualObservations.push(parsed);
    }
    if (item.kind === "vision_compliance") {
      const parsed = parseVisionComplianceEvidence(item.result, task);
      if (item.segment && Array.isArray(parsed.notes)) {
        parsed.notes.unshift(`Vision pass: ${item.segment}`);
      }
      visualSignals.push(parsed);
    }
    if (item.kind === "asr_transcript") {
      signals.push(parseAsrEvidence(item.result, task, metrics));
    }
  }

  if (visualSignals.length > 0 || visualObservations.length > 0) {
    signals.push(aggregateVisualSignals({ task, signals: visualSignals, observations: visualObservations }));
  }

  return mergeSignals(...signals);
}

async function safeEvidenceCall(run) {
  try {
    return await run();
  } catch (error) {
    return {
      ok: false,
      status: "error",
      error: error.message
    };
  }
}

async function safeHermesReview(payload) {
  try {
    return await hermes.createReviewBrief(payload);
  } catch (error) {
    return {
      ok: false,
      status: "error",
      headline: "Hermes review unavailable",
      reviewBrief: "The deterministic verdict is available, but Hermes could not generate the reviewer brief for this run.",
      recommendedAction: "send_to_human_review",
      contributorFeedback: "",
      routingReason: error.message,
      reviewChecklist: []
    };
  }
}

function refineHermesFeedback({ task, result, modelSignals, hermesReview }) {
  if (!hermesReview || !hasTaskMismatch(result)) return;

  const requested = cleanSentence(task.objective || task.name || "the requested dataset task");
  const observed = observedSubmissionSummary(modelSignals);
  const promptFeedback = promptMismatchFeedback(task, modelSignals);
  const feedback = promptFeedback ||
    (observed
      ? `This task asks for ${requested}, but the submission appears to show ${observed}. Please submit media that matches the requested collection.`
      : `This task asks for ${requested}, but the submission did not show the required subject or action clearly enough. Please submit media that matches the requested collection.`);

  if (shouldReplaceContributorFeedback(hermesReview.contributorFeedback, feedback)) {
    hermesReview.contributorFeedback = feedback;
  }

  if (result.verdict === "rejected") {
    hermesReview.recommendedAction = "reject";
  }

  if (!hermesReview.headline || /quality|review completed|submission/i.test(hermesReview.headline)) {
    hermesReview.headline = "Task mismatch detected";
  }

  if (!hermesReview.routingReason || /quality|technical|score/i.test(hermesReview.routingReason)) {
    hermesReview.routingReason = "Hermes routed this as a task mismatch because semantic evidence is more important than passing file-level checks.";
  }
}

function hasTaskMismatch(result) {
  const text = [...(result.blockers || []), ...(result.reviewReasons || [])].join(" ");
  return /does not match|required scene|task-specific subject|task-specific action|spoken prompt|prompt mismatch/i.test(text);
}

function observedSubmissionSummary(modelSignals = {}) {
  const notes = Array.isArray(modelSignals.notes) ? modelSignals.notes : [];
  const subjects = firstNoteValues(notes, "Observed subjects:");
  const actions = firstNoteValues(notes, "Observed actions:");
  const scene = firstNoteText(notes, "Observed scene:");
  const visualScene = firstNoteText(notes, "Scene:");

  if (actions && subjects) return truncateText(`${actions} involving ${subjects}`, 180);
  if (actions) return truncateText(actions, 180);
  if (subjects) return truncateText(subjects, 180);
  if (scene) return truncateText(scene, 180);
  if (visualScene) return truncateText(visualScene, 180);
  return "";
}

function promptMismatchFeedback(task, modelSignals = {}) {
  if (task.mediaKind !== "audio") return "";
  const transcript = String(modelSignals.transcript || "").trim();
  const expected = extractPromptText(task.promptText || task.objective || "");
  if (!expected || !transcript) return "";
  return `This task asks for the exact phrase "${expected}", but ASR heard "${truncateText(transcript, 120)}". Please record the requested sentence once, clearly.`;
}

function shouldReplaceContributorFeedback(current, next) {
  if (!current) return true;
  if (current === next) return false;
  return !/but the submission appears to show|but ASR heard/i.test(current);
}

function firstNoteValues(notes, prefix) {
  const value = firstNoteText(notes, prefix);
  if (!value) return "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
}

function firstNoteText(notes, prefix) {
  const found = notes.find((note) => String(note).startsWith(prefix));
  return found ? String(found).slice(prefix.length).trim() : "";
}

function extractPromptText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted?.[1]) return quoted[1].trim();
  const afterColon = text.match(/(?:say|saying|sentence|phrase).*?:\s*(.+)$/i);
  if (afterColon?.[1]) return afterColon[1].replace(/\s*(speak|record|read)\b.*$/i, "").trim();
  return text;
}

function cleanSentence(value) {
  return String(value || "").trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
}

function truncateText(value, max) {
  const text = cleanSentence(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function applyHermesRouting({ result, task, hermesReview }) {
  const action = normalizeHermesAction(hermesReview?.recommendedAction);
  result.orchestratorAction = {
    source: "hermes",
    action,
    applied: false,
    reason: hermesReview?.routingReason || ""
  };

  if (!hermesReview?.ok || !action) return result;

  const hardBlockers = result.blockers?.length > 0;
  const privacyRisk = (result.reviewReasons || []).some((reason) => /^Privacy signals found/i.test(reason));
  const criticalReviewReasons = (result.reviewReasons || []).filter((reason) => !isSoftReviewReason(reason));

  if (action === "accept" && !hardBlockers && !privacyRisk && result.score >= task.thresholds.acceptScore - 6) {
    result.reviewReasons = criticalReviewReasons;
    if (result.reviewReasons.length === 0) {
      result.verdict = "accepted";
      result.orchestratorAction.applied = true;
      rewriteFinalTimeline(result.timeline, "Hermes finalized accepted routing", "Cleared for dataset ingestion");
      result.summary = buildResultSummary(result);
    }
  }

  if (action === "send_to_human_review" && result.verdict === "accepted" && result.confidence < 0.76) {
    result.verdict = "needs_review";
    result.reviewReasons = result.reviewReasons || [];
    result.reviewReasons.push("Hermes requested reviewer confirmation");
    result.orchestratorAction.applied = true;
    rewriteFinalTimeline(result.timeline, "Hermes requested reviewer confirmation", "Routed to human review");
    result.summary = buildResultSummary(result);
  }

  if (action === "reject" && (hardBlockers || result.score < task.thresholds.reviewScore)) {
    result.verdict = "rejected";
    result.orchestratorAction.applied = true;
    rewriteFinalTimeline(result.timeline, "Hermes confirmed rejection route", "Rejected with auditable hard-failure evidence");
    result.summary = buildResultSummary(result);
  }

  return result;
}

function normalizeHermesAction(value) {
  const action = String(value || "").trim().toLowerCase();
  if (["accept", "reject", "send_to_human_review", "request_more_evidence"].includes(action)) return action;
  return null;
}

function isSoftReviewReason(reason) {
  return /Task compliance confidence is medium|Semantic task compliance requires model or human review|Exposure is outside preferred range|Sharpness needs review|Duplicate signal unavailable/i.test(reason);
}

function rewriteFinalTimeline(timeline, hermesStep, finalStep) {
  const finalSteps = new Set([
    "Routed to human review",
    "Cleared for dataset ingestion",
    "Rejected with auditable hard-failure evidence"
  ]);
  while (timeline.length && finalSteps.has(timeline[timeline.length - 1])) timeline.pop();
  timeline.push(hermesStep);
  timeline.push(finalStep);
}

function buildResultSummary(result) {
  if (result.verdict === "accepted") {
    return `Accepted with quality score ${result.score}. Hermes finalized the route from model and quality evidence.`;
  }
  if (result.verdict === "rejected") {
    return `Rejected with quality score ${result.score}. ${result.blockers?.[0] || "Hard quality gate failed."}`;
  }
  return `Needs human review with quality score ${result.score}. ${
    result.reviewReasons?.[0] || "One or more signals require reviewer judgement."
  }`;
}

function buildCustomTask(input) {
  const mediaKind = String(input.mediaKind || "").toLowerCase();
  if (!["image", "video", "audio"].includes(mediaKind)) {
    throw new Error("mediaKind must be image, video, or audio");
  }

  const name = String(input.name || "").trim();
  const objective = String(input.objective || "").trim();
  if (!name) throw new Error("Task name is required");
  if (!objective) throw new Error("Task objective is required");

  const requiredSignals = splitSignals(input.requiredSignals).filter(isSemanticRequiredSignal);
  const privacySignals = splitSignals(input.privacySignals);
  const promptText = String(input.promptText || "").trim();

  const rules = {
    duplicateHammingMax: num(input.duplicateHammingMax, mediaKind === "image" ? 5 : 6),
    semanticRequired: mediaKind === "audio" && promptText
      ? unique([...requiredSignals, "prompt_match"])
      : requiredSignals,
    privacyReviewSignals: privacySignals
  };

  if (mediaKind === "image" || mediaKind === "video") {
    rules.minWidth = num(input.minWidth, mediaKind === "image" ? 1280 : 720);
    rules.minHeight = num(input.minHeight, mediaKind === "image" ? 720 : 480);
    rules.brightnessMin = num(input.brightnessMin, 18);
    rules.brightnessMax = num(input.brightnessMax, 88);
    if (String(input.minBlurScore || "").trim()) {
      rules.minBlurScore = num(input.minBlurScore, 16);
    }
  }

  if (mediaKind === "video" || mediaKind === "audio") {
    rules.minDurationSec = num(input.minDurationSec, mediaKind === "audio" ? 2 : 5);
    rules.maxDurationSec = num(input.maxDurationSec, mediaKind === "audio" ? 30 : 60);
  }

  if (mediaKind === "audio") {
    rules.minRms = num(input.minRms, 0.015);
    rules.maxSilenceRatio = num(input.maxSilenceRatio, 0.45);
  }

  return {
    id: `custom-${Date.now().toString(36)}`,
    name,
    collection: String(input.collection || "Custom collection").trim() || "Custom collection",
    mediaKind,
    objective,
    promptText,
    custom: true,
    rules,
    thresholds: {
      acceptScore: num(input.acceptScore, 82),
      reviewScore: num(input.reviewScore, 58)
    }
  };
}

function splitSignals(value) {
  return unique(
    String(value || "")
      .split(",")
      .map((item) =>
        item
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
      )
      .filter(Boolean)
  );
}

function unique(items) {
  return [...new Set(items)];
}

function isSemanticRequiredSignal(signal) {
  return !/^(resolution|width|height|min_width|min_height|duration|min_duration|max_duration|sharpness|blur|brightness|exposure|fps|frame_rate|framerate|bitrate|file_format|format)/.test(signal);
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

app.listen(port, () => {
  console.log(`Hermes Data Quality Agent listening on http://localhost:${port}`);
});
