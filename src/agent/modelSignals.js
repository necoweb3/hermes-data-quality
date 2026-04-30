function mergeSignals(...items) {
  const merged = {
    semantic: {},
    privacy: {},
    confidence: null,
    transcript: null,
    notes: []
  };

  for (const item of items) {
    if (!item) continue;
    mergeSignalMap(merged.semantic, item.semantic || {});
    mergeSignalMap(merged.privacy, item.privacy || {});
    if (typeof item.confidence === "number") {
      merged.confidence =
        typeof merged.confidence === "number"
          ? Math.max(merged.confidence, item.confidence)
          : item.confidence;
    }
    if (item.transcript && !merged.transcript) merged.transcript = item.transcript;
    if (Array.isArray(item.notes)) merged.notes.push(...item.notes);
    if (item.visualAnchor && !merged.visualAnchor) merged.visualAnchor = item.visualAnchor;
  }

  return merged;
}

function mergeSignalMap(target, source) {
  for (const [key, incoming] of Object.entries(source)) {
    target[key] = mergeSignalValue(target[key], incoming);
  }
}

function mergeSignalValue(existing, incoming) {
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  if (existing === true || incoming === true) return true;
  if (existing === false || incoming === false) return false;
  if (existing === null || incoming === null) return null;
  return incoming;
}

function parseAsrEvidence(result, task, metrics = {}) {
  const nested = result?.result || result;
  const transcript = nested?.payload?.transcript || "";
  if (!transcript) {
    return {
      semantic: {},
      privacy: {},
      confidence: null,
      transcript: "",
      notes: ["ASR did not return a transcript"]
    };
  }

  const prompt = extractSpokenPrompt(task.promptText || task.objective || "");
  const similarity = prompt ? textSimilarity(prompt, transcript) : null;
  const exactMatch = prompt ? normalizedUtterance(transcript) === normalizedUtterance(prompt) : false;
  const containsPrompt = prompt ? normalizedUtterance(transcript).includes(normalizedUtterance(prompt)) : false;
  const semantic = {};
  if (typeof similarity === "number") {
    if (exactMatch || containsPrompt || similarity >= 0.78) semantic.prompt_match = true;
    else if (similarity < 0.55) semantic.prompt_match = false;
  }
  applyAudioSignals({ semantic, task, transcript, prompt, metrics, exactMatch, containsPrompt, similarity });

  return {
    semantic,
    privacy: {},
    confidence: similarity,
    transcript,
    notes: [
      `ASR transcript: "${truncate(transcript, 120)}"`,
      prompt ? `Expected phrase: "${truncate(prompt, 120)}"` : "No exact spoken prompt configured",
      typeof similarity === "number"
        ? `Prompt match ${Math.round(similarity * 100)}`
        : "Prompt matching skipped because this task has no prompt text"
    ]
  };
}

function applyAudioSignals({ semantic, task, transcript, prompt, metrics, exactMatch, containsPrompt, similarity }) {
  if (task.mediaKind !== "audio") return;
  const required = task.rules?.semanticRequired || [];
  const transcriptPresent = normalizedUtterance(transcript).length > 0;
  const promptMatched = semantic.prompt_match === true;
  const durationOk =
    typeof metrics.durationSec === "number" &&
    metrics.durationSec >= (task.rules?.minDurationSec ?? 0) &&
    metrics.durationSec <= (task.rules?.maxDurationSec ?? Number.POSITIVE_INFINITY);
  const levelOk =
    typeof metrics.rms !== "number" ||
    metrics.rms >= (task.rules?.minRms ?? 0.015);
  const silenceOk =
    typeof metrics.silenceRatio !== "number" ||
    metrics.silenceRatio <= (task.rules?.maxSilenceRatio ?? 0.45);

  for (const signal of required) {
    const normalized = normalizeSignal(signal);
    if (semantic[signal] !== undefined) continue;
    if (["contains_exact_sentence", "exact_sentence", "target_sentence", "requested_sentence"].includes(normalized)) {
      semantic[signal] = exactMatch || containsPrompt || promptMatched;
    } else if (["clear_speech", "speech_clear", "intelligible_speech"].includes(normalized)) {
      semantic[signal] = transcriptPresent && levelOk;
    } else if (["minimal_background_noise", "low_background_noise", "clean_audio"].includes(normalized)) {
      semantic[signal] = transcriptPresent && silenceOk;
    } else if (["single_speaker", "one_speaker", "single_voice"].includes(normalized)) {
      semantic[signal] = promptMatched && durationOk && textSimilarity(prompt || "", transcript) >= 0.78;
    }
  }

  if (semantic.prompt_match === true && typeof similarity === "number" && similarity >= 0.78) {
    semantic.contains_exact_sentence = semantic.contains_exact_sentence ?? true;
  }
}

function extractSpokenPrompt(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const curly = text.match(/[“"]([^”"]+)[”"]/);
  if (curly?.[1]) return curly[1].trim();
  const afterColon = text.match(/(?:say|saying|sentence|phrase).*?:\s*(.+)$/i);
  if (afterColon?.[1]) return afterColon[1].replace(/\s*(speak|record|read)\b.*$/i, "").trim();
  return text;
}

function normalizedUtterance(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textSimilarity(expected, actual) {
  const left = tokenize(expected);
  const right = tokenize(actual);
  if (left.length === 0 || right.length === 0) return 0;
  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
}

function levenshtein(left, right) {
  const dp = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[left.length][right.length];
}

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function truncate(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function parseVisionComplianceEvidence(result, task) {
  const content = extractAssistantContent(result);
  if (!content) {
    return {
      semantic: {},
      privacy: {},
      confidence: null,
      notes: ["Vision compliance response was empty"]
    };
  }

  const parsed = parseJsonish(content);
  if (!parsed) {
    return {
      semantic: {},
      privacy: {},
      confidence: null,
      notes: ["Vision compliance response could not be parsed as JSON"]
    };
  }

  const required = task.rules.semanticRequired || [];
  const semantic = {};
  const visible = parsed.visible_required_elements || parsed.required_signals || parsed.required_elements || {};
  const visibleArray = asArray(parsed.visible_elements || parsed.visible_required_elements);
  const missingArray = asArray(parsed.missing_required_elements || parsed.missing_elements);

  for (const signal of required) {
    const value = findSignalValue(visible, signal);
    const parsedValue = parseSignalValue(value);
    if (parsedValue !== undefined) semantic[signal] = parsedValue;
    if (value && typeof value === "object" && typeof value.visible === "boolean") {
      semantic[signal] = value.visible;
    }
    if (visibleArray.some((item) => sameSignal(item, signal))) semantic[signal] = true;
    if (missingArray.some((item) => sameSignal(item, signal))) semantic[signal] = false;
  }

  const confidence = normalizeScore(
    parsed.task_match_score ?? parsed.task_compliance_score ?? parsed.confidence
  );
  const clearMismatch = parsed.wrong_subject_or_activity === true ||
    parsed.clear_mismatch === true ||
    parsed.task_mismatch === true ||
    parsed.scene_mismatch === true;

  if (clearMismatch) {
    for (const signal of required) semantic[signal] = false;
  }

  applyEvidenceHints({ semantic, required, parsed, task });
  if (!clearMismatch) {
    promoteHighConfidenceVisualSignals({ semantic, required, parsed, task, confidence });
    softenAmbiguousVisualFalseSignals({ semantic, required, parsed, task });
  }

  if (typeof confidence === "number" && confidence < 0.35) {
    for (const signal of required) {
      if (semantic[signal] === undefined || semantic[signal] === null) semantic[signal] = false;
    }
  }

  const privacy = {};
  const privacyFlags = parsed.privacy_flags ?? parsed.privacy_risks ?? parsed.sensitive_content;
  if (Array.isArray(privacyFlags)) {
    for (const flag of privacyFlags) {
      if (typeof flag === "string" && flag.trim()) privacy[normalizeSignal(flag)] = true;
    }
    if (privacyFlags.length === 0) {
      for (const signal of task.rules.privacyReviewSignals || []) privacy[signal] = false;
    }
  } else if (privacyFlags && typeof privacyFlags === "object") {
    for (const [key, value] of Object.entries(privacyFlags)) {
      privacy[normalizeSignal(key)] = Boolean(value);
    }
  } else if (parsed.no_privacy_flags === true) {
    for (const signal of task.rules.privacyReviewSignals || []) privacy[signal] = false;
  }

  const notes = [];
  if (typeof confidence === "number") notes.push(`Vision task match score ${Math.round(confidence * 100)}`);
  if (parsed.agent_inference) notes.push(String(parsed.agent_inference));
  if (parsed.scene_summary) notes.push(`Scene: ${truncate(parsed.scene_summary, 160)}`);
  if (parsed.reviewer_next_step) notes.push(String(parsed.reviewer_next_step));
  if (clearMismatch) notes.push("Vision model flagged a clear task mismatch.");
  if (Array.isArray(parsed.rejection_risks) && parsed.rejection_risks.length > 0) {
    notes.push(`Risks: ${parsed.rejection_risks.join(", ")}`);
  }

  return {
    semantic,
    privacy,
    confidence,
    notes,
    raw: parsed
  };
}

function parseVisualObservationEvidence(result) {
  const content = extractAssistantContent(result);
  if (!content) {
    return {
      observationText: "",
      notes: ["Visual observation response was empty"],
      raw: null
    };
  }

  const parsed = parseJsonish(content);
  if (!parsed) {
    return {
      observationText: content.toLowerCase(),
      notes: [`Visual observation: ${truncate(content, 180)}`],
      raw: null
    };
  }

  const text = observationText(parsed);
  const notes = [];
  if (parsed.scene_summary) notes.push(`Observed scene: ${truncate(parsed.scene_summary, 160)}`);
  if (Array.isArray(parsed.subjects) && parsed.subjects.length) {
    notes.push(`Observed subjects: ${parsed.subjects.join(", ")}`);
  }
  if (Array.isArray(parsed.actions) && parsed.actions.length) {
    notes.push(`Observed actions: ${parsed.actions.join(", ")}`);
  }

  return {
    observationText: text,
    notes,
    raw: parsed
  };
}

function aggregateVisualSignals({ task, signals, observations = [] }) {
  const required = task.rules?.semanticRequired || [];
  const semantic = {};
  const confidenceValues = signals
    .map((signal) => signal.confidence)
    .filter((value) => typeof value === "number");
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : null;
  const notes = [
    ...observations.flatMap((item) => item.notes || []),
    ...signals.flatMap((item) => item.notes || [])
  ];

  const observationCorpus = observations.map((item) => item.observationText).filter(Boolean).join(" ");
  const taskSpecific = required.filter((signal) => isTaskSpecificVisualSignal(signal, task));
  const anchor = visualAnchorCheck(task, taskSpecific, observationCorpus);
  const clearMismatch = signals.some((signal) => signal.raw?.wrong_subject_or_activity === true);
  const hasObservation = observationCorpus.trim().length > 0;
  const videoStrict = task.mediaKind === "video" && (signals.length > 1 || observations.length > 0);

  for (const signal of required) {
    const values = signals
      .map((item) => item.semantic?.[signal])
      .filter((value) => value !== undefined);
    const trueCount = values.filter((value) => value === true).length;
    const falseCount = values.filter((value) => value === false).length;
    const isTaskSpecific = taskSpecific.includes(signal);

    if (clearMismatch || (isTaskSpecific && anchor.status === "missing")) {
      semantic[signal] = false;
      continue;
    }

    if (videoStrict) {
      if (trueCount >= 2 && trueCount > falseCount) {
        semantic[signal] = true;
      } else if (falseCount >= 2 || falseCount > trueCount) {
        semantic[signal] = false;
      } else if (trueCount === 1 && !hasObservation && falseCount === 0) {
        semantic[signal] = null;
      } else if (trueCount === 1 && falseCount === 0 && !isTaskSpecific) {
        semantic[signal] = null;
      } else {
        semantic[signal] = null;
      }
    } else if (trueCount > falseCount) {
      semantic[signal] = true;
    } else if (falseCount > trueCount) {
      semantic[signal] = false;
    } else if (values.includes(null)) {
      semantic[signal] = null;
    }
  }

  if (anchor.status === "missing") {
    notes.unshift(`Task-agnostic visual observation did not show task anchors: ${anchor.expected.join(", ")}`);
  }
  if (clearMismatch) {
    notes.unshift("At least one visual pass flagged a clear subject/activity mismatch.");
  }

  return {
    semantic,
    privacy: mergeSignals(...signals).privacy,
    confidence: anchor.status === "missing" || clearMismatch ? Math.min(confidence ?? 0.1, 0.1) : confidence,
    notes,
    visualAnchor: anchor
  };
}

function parseSignalValue(value) {
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  if (typeof value === "string") {
    const normalized = normalizeSignal(value);
    if (["true", "yes", "present", "visible", "met", "pass"].includes(normalized)) return true;
    if (["false", "no", "absent", "missing", "not_visible", "fail"].includes(normalized)) return false;
    if (["unknown", "unclear", "unsure", "maybe", "partial", "null"].includes(normalized)) return null;
  }
  if (value && typeof value === "object") {
    return parseSignalValue(value.visible ?? value.present ?? value.met ?? value.value ?? value.status);
  }
  return undefined;
}

function extractAssistantContent(result) {
  const nested = result?.result || result;
  return nested?.payload?.choices?.[0]?.message?.content || nested?.payload?.choices?.[0]?.text || "";
}

function parseJsonish(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const candidates = [withoutFence];
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(withoutFence.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function findSignalValue(objectOrArray, signal) {
  if (!objectOrArray || typeof objectOrArray !== "object" || Array.isArray(objectOrArray)) {
    return undefined;
  }
  const target = normalizeSignal(signal);
  for (const [key, value] of Object.entries(objectOrArray)) {
    if (normalizeSignal(key) === target) return value;
  }
  return undefined;
}

function normalizeScore(value) {
  if (typeof value === "string") value = Number(value.replace("%", ""));
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function sameSignal(left, right) {
  return normalizeSignal(left) === normalizeSignal(right);
}

function applyEvidenceHints({ semantic, required, parsed, task }) {
  const haystack = evidenceText(parsed, task);
  const hintSets = [
    {
      signals: [
        "parkour_trick_or_movement",
        "parkour_movement",
        "freerunning_movement",
        "active_parkour_maneuver"
      ],
      terms: ["parkour", "freerunning", "vault", "jump", "leap", "landing", "wall run", "climb", "roof"]
    },
    {
      signals: ["obstacle_interaction", "obstacle_navigation", "obstacle_clearance"],
      terms: ["obstacle", "barrier", "rail", "wall", "ledge", "vault", "jump over", "leap over", "over"]
    },
    {
      signals: ["dynamic_camera_motion", "camera_motion", "movement", "continuous_motion", "continuous_action"],
      terms: ["motion", "moving", "sequence", "frames", "camera", "pov", "forward", "dynamic", "continuous"]
    },
    {
      signals: ["legs_visible", "leg_visible", "feet_visible"],
      terms: ["leg", "legs", "foot", "feet", "shoe", "shoes"]
    },
    {
      signals: ["hands_visible", "hand_visible"],
      terms: ["hand", "hands", "wrist", "fingers"]
    }
  ];

  for (const signal of required) {
    if (semantic[signal] !== undefined) continue;
    const normalized = normalizeSignal(signal);
    const hint = hintSets.find((item) => item.signals.includes(normalized));
    if (hint?.terms.some((term) => haystack.includes(term))) {
      semantic[signal] = true;
      continue;
    }
    if (textSupportsSignal(haystack, signal, task)) semantic[signal] = true;
  }
}

function softenAmbiguousVisualFalseSignals({ semantic, required, parsed, task }) {
  if (!isVisualTask(task)) return;
  const hasPositiveSignal = Object.values(semantic).some((value) => value === true);
  if (!hasPositiveSignal) return;

  const ambiguousSignals = new Set([
    "hands_visible",
    "hand_visible",
    "legs_visible",
    "leg_visible",
    "feet_visible",
    "dynamic_camera_motion",
    "parkour_trick_or_movement",
    "freerunning_movement",
    "continuous_motion",
    "continuous_action"
  ]);
  const haystack = evidenceText(parsed, task);

  for (const signal of required) {
    const normalized = normalizeSignal(signal);
    if (semantic[signal] !== false) continue;
    const isAmbiguousVisualSignal = ambiguousSignals.has(normalized) || isPromotableVisualSignal(normalized);
    if (!isAmbiguousVisualSignal) continue;
    if (hasExplicitNegativeEvidence(haystack, normalized)) continue;
    semantic[signal] = null;
  }
}

function promoteHighConfidenceVisualSignals({ semantic, required, parsed, task, confidence }) {
  if (!isVisualTask(task)) return;
  if (typeof confidence !== "number" || confidence < 0.78) return;

  const positiveCount = Object.values(semantic).filter((value) => value === true).length;
  const positiveRatio = required.length ? positiveCount / required.length : 0;
  const hasCoreEvidence = hasPositiveCoreVisualEvidence(semantic);
  const strongOverallMatch = confidence >= 0.84 && positiveRatio >= 0.5;
  const goodOverallMatch = confidence >= 0.78 && (positiveRatio >= 0.6 || hasCoreEvidence);
  if (!strongOverallMatch && !goodOverallMatch) return;

  const haystack = evidenceText(parsed, task);
  let promoted = false;

  for (const signal of required) {
    const normalized = normalizeSignal(signal);
    if (semantic[signal] === true) continue;
    if (semantic[signal] !== false && semantic[signal] !== undefined && semantic[signal] !== null) continue;
    if (!isPromotableVisualSignal(normalized)) continue;
    if (hasExplicitNegativeEvidence(haystack, normalized)) continue;
    semantic[signal] = true;
    promoted = true;
  }

  if (promoted) {
    parsed.agent_inference = "High-confidence visual task match promoted ambiguous semantic signals.";
  }
}

function hasPositiveCoreVisualEvidence(semantic) {
  const keys = Object.keys(semantic);
  const hasPov = keys.some((key) => /pov|first_person|perspective/.test(normalizeSignal(key)) && semantic[key] === true);
  const hasBodyPart = keys.some((key) => /hand|leg|foot|feet|limb/.test(normalizeSignal(key)) && semantic[key] === true);
  const hasAction = keys.some((key) => /action|motion|movement|interaction|activity|manipulation|using|holding/.test(normalizeSignal(key)) && semantic[key] === true);
  const hasObject = keys.some((key) => /object|item|tool|dish|cup|door|screen|document|person|people|vehicle|animal|product/.test(normalizeSignal(key)) && semantic[key] === true);
  return (hasPov && hasBodyPart) || (hasAction && hasObject);
}

function isPromotableVisualSignal(signal) {
  if (isSensitiveOrTechnicalSignal(signal)) return false;
  return /visible|present|scene|object|item|tool|motion|movement|action|activity|interaction|manipulation|pov|first_person|perspective|parkour|freerunning|maneuver|obstacle|jump|vault|run|walk|climb|wash|clean|cook|drive|hold|use|place|open|close/.test(signal);
}

function isSensitiveOrTechnicalSignal(signal) {
  return /privacy|face|identity|identifiable|minor|child|age|gender|male|female|race|ethnicity|license|plate|document|badge|medical|screen|address|phone|email|pii|count|number|multiple|single|resolution|width|height|duration|sharpness|blur|brightness|exposure|audio|prompt|transcript/.test(signal);
}

function textSupportsSignal(haystack, signal, task) {
  const tokens = meaningfulTokens(signal);
  if (tokens.length === 0) return false;
  const directHits = tokens.filter((token) => haystack.includes(token)).length;
  if (tokens.length === 1) return directHits === 1 && tokenIsSpecific(tokens[0]);
  if (directHits >= Math.min(tokens.length, 2)) return true;

  const taskTokens = meaningfulTokens(`${task.name || ""} ${task.objective || ""}`);
  const taskHits = tokens.filter((token) => taskTokens.includes(token)).length;
  return taskHits > 0 && directHits > 0;
}

function meaningfulTokens(value) {
  const stop = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "clearly",
    "during",
    "for",
    "from",
    "in",
    "is",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
    "where",
    "visible",
    "present",
    "required",
    "should",
    "must",
    "show"
  ]);
  return normalizeSignal(value)
    .split("_")
    .filter((token) => token.length > 2 && !stop.has(token));
}

function tokenIsSpecific(token) {
  return !["object", "item", "scene", "action", "motion", "activity"].includes(token);
}

function evidenceText(parsed, task) {
  const parts = [
    parsed.scene_summary,
    parsed.summary,
    parsed.description,
    parsed.caption,
    parsed.visual_summary,
    parsed.rationale,
    parsed.reasoning,
    parsed.reviewer_next_step
  ];
  for (const key of ["visible_elements", "observed_elements", "actions", "objects", "scene_tags"]) {
    if (Array.isArray(parsed[key])) parts.push(parsed[key].join(" "));
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function observationText(parsed) {
  const parts = [
    parsed.scene_summary,
    parsed.summary,
    parsed.description,
    parsed.caption,
    parsed.environment,
    parsed.camera_perspective
  ];
  for (const key of [
    "subjects",
    "actions",
    "objects",
    "visible_body_parts",
    "negative_observations",
    "scene_tags"
  ]) {
    if (Array.isArray(parsed[key])) parts.push(parsed[key].join(" "));
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function visualAnchorCheck(task, taskSpecificSignals, observedText) {
  if (!isVisualTask(task) || taskSpecificSignals.length === 0) {
    return { status: "not_required", expected: [] };
  }
  if (!observedText) {
    return { status: "unknown", expected: buildVisualAnchors(task, taskSpecificSignals) };
  }

  const anchors = buildVisualAnchors(task, taskSpecificSignals);
  if (anchors.length === 0) return { status: "not_required", expected: [] };
  const hit = anchors.some((anchor) => observationHasAnchor(observedText, anchor));
  return {
    status: hit ? "present" : "missing",
    expected: anchors
  };
}

function observationHasAnchor(observedText, anchor) {
  const normalizedAnchor = normalizeSignal(anchor).replaceAll("_", " ");
  const observedTokens = new Set(tokenize(observedText));
  const anchorTokens = tokenize(normalizedAnchor);
  if (anchorTokens.length === 0) return false;
  if (anchorTokens.length === 1) return observedTokens.has(anchorTokens[0]);
  return observedText.includes(normalizedAnchor);
}

function buildVisualAnchors(task, taskSpecificSignals) {
  const source = normalizeSignal(
    `${task.name || ""} ${task.objective || ""} ${taskSpecificSignals.join(" ")}`
  );
  const sourceTokens = new Set(source.split("_").filter(Boolean));
  const anchors = new Set();
  const add = (items) => items.forEach((item) => anchors.add(item));

  if (/parkour|freerunning|maneuver|vault|obstacle/.test(source)) {
    add(["parkour", "freerunning", "vault", "jump", "leap", "landing", "climb", "rail", "wall", "ledge", "obstacle", "running"]);
  }
  if (/dish|washing|sink|kitchen|faucet|cup|plate/.test(source)) {
    add(["dish", "dishes", "sink", "kitchen", "water", "faucet", "washing", "soap", "sponge", "plate", "cup"]);
  }
  if (sourceTokens.has("walk") || sourceTokens.has("walking")) {
    add(["walk", "walking", "person", "people", "pedestrian", "feet", "legs", "sidewalk", "path"]);
  }
  if (sourceTokens.has("run") || sourceTokens.has("running")) {
    add(["run", "running", "jog", "person", "people", "feet", "legs"]);
  }
  if (/cook|cooking|food|meal/.test(source)) {
    add(["cook", "cooking", "food", "pan", "pot", "stove", "kitchen", "knife"]);
  }
  if (/drive|driving|car|vehicle/.test(source)) {
    add(["drive", "driving", "car", "vehicle", "road", "steering", "dashboard"]);
  }

  for (const token of meaningfulTokens(source)) {
    if (tokenIsSpecific(token) && !isGenericVisualAnchor(token)) anchors.add(token);
  }

  return [...anchors].slice(0, 24);
}

function isTaskSpecificVisualSignal(signal, task) {
  if (!isVisualTask(task)) return false;
  const normalized = normalizeSignal(signal);
  if (/^(pov|first_person|first_person_pov|first_person_perspective|camera_perspective)$/.test(normalized)) return false;
  if (/^(hands?|hands_visible|hand_visible|legs?|legs_visible|leg_visible|feet_visible|body_visible|limbs_visible)$/.test(normalized)) return false;
  if (/^(visible|present|clear|sharp|natural_scene|outdoor_scene|dynamic_camera_motion|camera_motion|continuous_motion)$/.test(normalized)) return false;
  return true;
}

function isGenericVisualAnchor(token) {
  return new Set([
    "active",
    "action",
    "camera",
    "clear",
    "clip",
    "clips",
    "collect",
    "contributor",
    "data",
    "dynamic",
    "first",
    "hand",
    "hands",
    "interaction",
    "leg",
    "legs",
    "maneuver",
    "maneuvers",
    "movement",
    "person",
    "perspective",
    "point",
    "pov",
    "requested",
    "video",
    "videos"
  ]).has(token);
}

function isVisualTask(task) {
  return task.mediaKind === "image" || task.mediaKind === "video";
}

function hasExplicitNegativeEvidence(text, signal) {
  const tokens = meaningfulTokens(signal);
  const phrase = tokens.join(" ");
  const phrases = {
    hands_visible: ["no hands", "hands are not visible", "hands not visible", "without hands"],
    hand_visible: ["no hand", "hand is not visible", "hand not visible"],
    legs_visible: ["no legs", "legs are not visible", "legs not visible", "without legs"],
    leg_visible: ["no leg", "leg is not visible", "leg not visible"],
    feet_visible: ["no feet", "feet are not visible", "feet not visible"],
    dynamic_camera_motion: ["static camera", "no camera motion", "camera is static"],
    parkour_trick_or_movement: ["no parkour", "not parkour", "no trick", "no freerunning"],
    freerunning_movement: ["no freerunning", "not freerunning"],
    continuous_motion: ["no continuous motion", "static scene"],
    continuous_action: ["no continuous action", "no action"]
  }[signal] || [];

  const genericPhrases = phrase
    ? [
        `no ${phrase}`,
        `not ${phrase}`,
        `without ${phrase}`,
        `${phrase} missing`,
        `${phrase} absent`,
        `${phrase} not visible`,
        `${phrase} is not visible`,
        `does not show ${phrase}`,
        `cannot see ${phrase}`
      ]
    : [];

  return [...phrases, ...genericPhrases].some((item) => text.includes(item));
}

function normalizeSignal(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

module.exports = {
  aggregateVisualSignals,
  mergeSignals,
  parseAsrEvidence,
  parseVisualObservationEvidence,
  parseVisionComplianceEvidence,
  parseJsonish,
  normalizeSignal,
  textSimilarity
};
