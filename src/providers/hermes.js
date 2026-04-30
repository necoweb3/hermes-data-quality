const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 180000;

class HermesProvider {
  constructor(env = process.env) {
    this.enabledFlag = env.HERMES_ENABLED !== "false";
    this.runner = env.HERMES_RUNNER || "wsl";
    this.wslDistro = env.HERMES_WSL_DISTRO || "Ubuntu-22.04";
    this.timeoutMs = Number(env.HERMES_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.projectRoot = env.HERMES_PROJECT_ROOT || process.cwd();
  }

  enabled() {
    return this.enabledFlag;
  }

  describe() {
    return {
      enabled: this.enabled(),
      runner: this.runner,
      distro: this.runner === "wsl" ? this.wslDistro : undefined,
      role: "review_orchestrator"
    };
  }

  async createReviewBrief({ task, file, metrics, verdict, modelSignals }) {
    if (!this.enabled()) {
      return {
        ok: false,
        status: "disabled",
        headline: "Hermes review disabled",
        reviewBrief: "Hermes orchestration is disabled for this run.",
        recommendedAction: "Review the deterministic verdict manually.",
        contributorFeedback: "",
        reviewChecklist: []
      };
    }

    const prompt = buildHermesPrompt({ task, file, metrics, verdict, modelSignals });
    const output = await this.runHermes(prompt);
    const parsed = extractHermesJson(output.stdout);

    return {
      ok: true,
      status: "completed",
      ...parsed,
      sessionHint: extractSessionHint(output.stdout)
    };
  }

  async planTask(description) {
    if (!this.enabled()) {
      throw new Error("Hermes task planning is disabled");
    }

    const prompt = buildTaskPlanPrompt(description);
    const output = await this.runHermes(prompt);
    const parsed = extractMarkerJson(output.stdout, {
      startMarker: "HERMES_TASK_JSON_BEGIN",
      endMarker: "HERMES_TASK_JSON_END",
      missingMessage: "Hermes task plan JSON was not found"
    });

    return {
      ok: true,
      status: "completed",
      ...normalizeTaskPlan(parsed),
      sessionHint: extractSessionHint(output.stdout)
    };
  }

  async runHermes(prompt) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-review-"));
    const promptPath = path.join(tempDir, "prompt.txt");
    await fs.writeFile(promptPath, prompt, "utf8");

    try {
      const command = this.buildCommand(promptPath);
      return await runProcess(command.file, command.args, {
        cwd: this.projectRoot,
        timeoutMs: this.timeoutMs
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  buildCommand(promptPath) {
    if (this.runner !== "wsl") {
      return {
        file: "hermes",
        args: ["chat", "-q", promptPath]
      };
    }

    const promptWslPath = windowsPathToWsl(promptPath);
    const projectWslPath = windowsPathToWsl(this.projectRoot);
    const helperPath = `${projectWslPath}/scripts/run_hermes_review.py`;
    const shellCommand = [
      `cd ${shellQuote(projectWslPath)}`,
      `python3 ${shellQuote(helperPath)} ${shellQuote(promptWslPath)}`
    ].join(" && ");

    return {
      file: "wsl.exe",
      args: ["-d", this.wslDistro, "--", "bash", "-lc", shellCommand]
    };
  }
}

function buildHermesPrompt({ task, file, metrics, verdict, modelSignals }) {
  const payload = {
    task: {
      name: task.name,
      collection: task.collection,
      mediaKind: task.mediaKind,
      objective: task.objective,
      promptText: task.promptText || "",
      mustShow: task.rules?.semanticRequired || [],
      reviewIfSeen: task.rules?.privacyReviewSignals || []
    },
    submission: {
      mediaKind: metrics.kind,
      fileType: file.type,
      fileSize: file.size,
      metrics: publicMetrics(metrics),
      verdict: verdict.verdict,
      score: verdict.score,
      confidence: verdict.confidence,
      blockers: verdict.blockers || [],
      reviewReasons: verdict.reviewReasons || [],
      checks: compactChecks(verdict.checks || []),
      taskSignals: modelSignals?.semantic || {},
      privacySignals: modelSignals?.privacy || {},
      modelNotes: Array.isArray(modelSignals?.notes) ? modelSignals.notes.slice(0, 12) : [],
      visualAnchor: modelSignals?.visualAnchor || null,
      transcript: modelSignals?.transcript || ""
    }
  };

  return `You are Hermes Agent operating the Data Quality Gate skill for a robotics and multimodal dataset intake workflow.

Hermes must act as the review orchestrator. Use the deterministic checks and model-derived signals as evidence, not absolute truth.

Submission evidence:
${JSON.stringify(payload, null, 2)}

Create a reviewer brief and final routing recommendation from the evidence above. Do not copy placeholder text. Do not ask for raw user files.

Routing policy:
- Recommend accept when there are no hard blockers, no privacy flags, and task compliance/model confidence supports the requested collection.
- Do not send clean high-confidence submissions to human review just because the task is semantic.
- Treat task compliance as the primary gate. Technical quality checks must never compensate for an unrelated scene, wrong activity, or missing task-specific subject/action.
- When task-specific evidence is absent but generic qualities pass, recommend reject or request_more_evidence instead of inflating confidence.
- Recommend send_to_human_review only for concrete uncertainty, safety/privacy concerns, conflicting model evidence, or low-confidence task match.
- Recommend reject only for hard technical failures, wrong media type, duplicate submissions, or clear task mismatch.
- If model notes describe the observed scene/action and it conflicts with the requested dataset, contributorFeedback must contrast them plainly. Example pattern: "This task asks for X, but the submission appears to show Y."

Return only valid JSON between the markers. The JSON values must be specific to the submission evidence. Do not include an empty template.

Field rules:
- headline: one short finding.
- reviewBrief: 2 concise sentences for the dataset operator.
- recommendedAction: exactly one of accept, reject, send_to_human_review, request_more_evidence.
- contributorFeedback: one short corrective sentence for the contributor.
- routingReason: why this route is appropriate.
- reviewChecklist: 2 to 4 concrete checks for a human reviewer.

HERMES_REVIEW_JSON_BEGIN
<write the completed JSON object here>
HERMES_REVIEW_JSON_END`;
}

function buildTaskPlanPrompt(description) {
  return `You are Hermes Agent operating the Data Quality Gate skill for a robotics and multimodal dataset intake workflow.

Hermes must convert a vague dataset collection request into enforceable quality gates for an intake system.

Dataset request:
${String(description || "").trim()}

Create a practical task plan. Prefer conservative human-review routing for ambiguous semantic or privacy cases. Do not ask for raw user files.
If the request asks for gender, age, accent, or other speaker identity/profile attributes, do not make automated demographic inference a hard gate. Represent that requirement as contributor-provided metadata or a human-review signal.

Return only valid JSON between the markers. The JSON values must be specific to the dataset request.

Field rules:
- name: short task name.
- collection: short collection category.
- mediaKind: exactly one of image, video, audio.
- objective: one clear sentence.
- requiredSignals: 3 to 7 snake_case semantic strings that the submission must show. Do not include technical thresholds such as resolution, fps, frame_rate, bitrate, duration, sharpness, exposure, or file format here.
- privacySignals: 2 to 6 snake_case strings that should trigger review if seen.
- minDurationSec and maxDurationSec: numbers for video/audio, null for image. Keep video maxDurationSec at or below 180 and audio maxDurationSec at or below 60.
- minWidth and minHeight: numbers for image/video, null for audio.
- promptText: spoken prompt for audio tasks, otherwise empty string.

HERMES_TASK_JSON_BEGIN
<write the completed JSON object here>
HERMES_TASK_JSON_END`;
}

function publicMetrics(metrics) {
  return {
    width: metrics.width || null,
    height: metrics.height || null,
    durationSec: round(metrics.durationSec),
    blurScore: round(metrics.blurScore),
    brightness: round(metrics.brightness),
    motionScore: round(metrics.motionScore),
    rms: round(metrics.rms, 4),
    silenceRatio: round(metrics.silenceRatio, 4)
  };
}

function compactChecks(checks) {
  return checks.map((check) => ({
    label: check.label,
    status: check.status,
    detail: check.detail
  }));
}

function round(value, digits = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
}

function extractHermesJson(stdout) {
  const parsed = extractMarkerJson(stdout, {
    startMarker: "HERMES_REVIEW_JSON_BEGIN",
    endMarker: "HERMES_REVIEW_JSON_END",
    missingMessage: "Hermes review JSON was not found"
  });
  return normalizeReview(parsed);
}

function extractMarkerJson(stdout, { startMarker, endMarker, missingMessage }) {
  const start = stdout.lastIndexOf(startMarker);
  const end = stdout.indexOf(endMarker, start);
  const source = start >= 0 && end > start
    ? stdout.slice(start + startMarker.length, end)
    : stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);

  const jsonStart = source.indexOf("{");
  const jsonEnd = source.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(missingMessage);
  }

  const jsonText = source.slice(jsonStart, jsonEnd + 1);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    parsed = JSON.parse(repairJsonStringNewlines(jsonText));
  }
  return parsed;
}

function repairJsonStringNewlines(jsonText) {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (const char of jsonText) {
    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      repaired += char;
      continue;
    }
    if (inString && (char === "\n" || char === "\r")) {
      repaired += " ";
      continue;
    }
    repaired += char;
  }

  return repaired;
}

function normalizeReview(value) {
  return {
    headline: stringOr(value.headline, "Hermes review completed"),
    reviewBrief: stringOr(value.reviewBrief, "Hermes reviewed the submission evidence."),
    recommendedAction: stringOr(value.recommendedAction, "send_to_human_review"),
    contributorFeedback: stringOr(value.contributorFeedback, ""),
    routingReason: stringOr(value.routingReason, ""),
    reviewChecklist: Array.isArray(value.reviewChecklist)
      ? value.reviewChecklist.map((item) => String(item)).slice(0, 5)
      : []
  };
}

function normalizeTaskPlan(value) {
  const mediaKind = ["image", "video", "audio"].includes(value.mediaKind) ? value.mediaKind : "video";
  const audio = mediaKind === "audio";
  const visual = mediaKind === "image" || mediaKind === "video";
  const minDuration = audio || mediaKind === "video"
    ? numberWithin(value.minDurationSec, audio ? 2 : 5, 0, audio ? 15 : 60)
    : null;
  const maxDuration = audio || mediaKind === "video"
    ? Math.max(
        minDuration || 0,
        numberWithin(value.maxDurationSec, audio ? 30 : 60, audio ? 3 : 5, audio ? 60 : 180)
      )
    : null;

  return {
    name: stringOr(value.name, "Hermes planned task"),
    collection: stringOr(value.collection, "Hermes planned collection"),
    mediaKind,
    objective: stringOr(value.objective, "Collect a submission that matches the requested dataset task."),
    requiredSignals: normalizeSignalList(value.requiredSignals, audio ? ["prompt_match", "single_speaker"] : ["task_relevant"]),
    privacySignals: normalizeSignalList(value.privacySignals, ["faces", "screens", "documents"]),
    minDurationSec: minDuration,
    maxDurationSec: maxDuration,
    minWidth: visual ? numberOr(value.minWidth, mediaKind === "image" ? 1280 : 720) : null,
    minHeight: visual ? numberOr(value.minHeight, mediaKind === "image" ? 720 : 480) : null,
    promptText: audio ? stringOr(value.promptText, "") : ""
  };
}

function normalizeSignalList(value, fallback) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const items = raw
    .map((item) =>
      String(item)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
    )
    .filter(Boolean);
  const unique = [...new Set(items)];
  return unique.length ? unique.slice(0, 8) : fallback;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberWithin(value, fallback, min, max) {
  return Math.max(min, Math.min(max, numberOr(value, fallback)));
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function extractSessionHint(stdout) {
  const match = stdout.match(/hermes --resume\s+([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function windowsPathToWsl(inputPath) {
  const resolved = path.resolve(inputPath).replace(/\\/g, "/");
  const drive = resolved.match(/^([A-Za-z]):\/(.*)$/);
  if (!drive) return resolved;
  return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runProcess(file, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      env: dedupeWindowsPathEnv(process.env)
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Hermes review timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(stderr || stdout || `Hermes exited with code ${code}`));
    });
  });
}

function dedupeWindowsPathEnv(env) {
  const next = { ...env };
  if (next.Path && next.PATH) delete next.PATH;
  return next;
}

module.exports = {
  HermesProvider,
  buildHermesPrompt,
  buildTaskPlanPrompt,
  extractHermesJson
};
