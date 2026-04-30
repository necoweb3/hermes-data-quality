function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scoreRange(value, min, max, label, weight, checks, blocking = true) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    checks.push({
      label,
      status: "review",
      detail: "Signal unavailable",
      weight
    });
    return { score: weight * 0.45, blockingFailure: false, review: true };
  }

  const passed = value >= min && value <= max;
  checks.push({
    label,
    status: passed ? "pass" : blocking ? "fail" : "review",
    detail: `${round(value)} expected ${min}-${max}`,
    weight
  });

  return {
    score: passed ? weight : blocking ? 0 : weight * 0.45,
    blockingFailure: blocking && !passed,
    review: !blocking && !passed
  };
}

function scoreMin(value, min, label, weight, checks, blocking = true) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    checks.push({
      label,
      status: "review",
      detail: "Signal unavailable",
      weight
    });
    return { score: weight * 0.45, blockingFailure: false, review: true };
  }

  const passed = value >= min;
  checks.push({
    label,
    status: passed ? "pass" : blocking ? "fail" : "review",
    detail: `${round(value)} expected >= ${min}`,
    weight
  });

  return {
    score: passed ? weight : blocking ? 0 : weight * 0.45,
    blockingFailure: blocking && !passed,
    review: !blocking && !passed
  };
}

function scoreResolution(metrics, task, checks) {
  const minWidth = task.rules.minWidth;
  const minHeight = task.rules.minHeight;
  const width = metrics.width;
  const height = metrics.height;
  const weight = 10;

  if (typeof width !== "number" || typeof height !== "number") {
    checks.push({
      label: "Resolution",
      status: "review",
      detail: "Signal unavailable",
      weight
    });
    return { score: weight * 0.45, blockingFailure: false, review: true, weight };
  }

  const strictPass = width >= minWidth && height >= minHeight;
  const orientationPass =
    task.mediaKind === "video" &&
    Math.max(width, height) >= Math.max(minWidth, minHeight) &&
    Math.min(width, height) >= Math.min(minWidth, minHeight);
  const passed = strictPass || orientationPass;
  const detail = orientationPass && !strictPass
    ? `${width} x ${height} satisfies ${minWidth} x ${minHeight} in portrait orientation`
    : `${width} x ${height} expected >= ${minWidth} x ${minHeight}`;

  checks.push({
    label: "Resolution",
    status: passed ? "pass" : "fail",
    detail,
    weight
  });

  return {
    score: passed ? weight : 0,
    blockingFailure: !passed,
    review: false,
    weight
  };
}

function hammingHex(left, right) {
  if (!left || !right || left.length !== right.length) return null;
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    const value = Number.parseInt(left[i], 16) ^ Number.parseInt(right[i], 16);
    distance += value.toString(2).replaceAll("0", "").length;
  }
  return distance;
}

function findDuplicate(currentHash, previousHashes, maxDistance) {
  if (!currentHash || !Array.isArray(previousHashes)) return null;
  let best = null;
  for (const item of previousHashes) {
    const distance = hammingHex(currentHash, item.hash);
    if (distance === null) continue;
    if (!best || distance < best.distance) {
      best = { id: item.id, fileName: item.fileName, distance };
    }
  }
  if (best && best.distance <= maxDistance) return best;
  return null;
}

function round(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return value;
  return Math.round(value * 100) / 100;
}

function taskMismatchScoreCap(ratio) {
  if (ratio <= 0.05) return 0;
  if (ratio <= 0.2) return 10;
  return 30;
}

function evaluateSubmission({ task, metrics, previousHashes = [], reviewerSignals = {} }) {
  const checks = [];
  const blockers = [];
  const reviewReasons = [];
  const timeline = [];
  let total = 0;
  let earned = 0;

  function addResult(result, blockerText, reviewText) {
    total += result.score === undefined ? 0 : result.weight || 0;
    earned += result.score || 0;
    if (result.blockingFailure && blockerText) blockers.push(blockerText);
    if (result.review && reviewText) reviewReasons.push(reviewText);
  }

  function blockingForVisualSignal(signalName) {
    if (task.mediaKind !== "video") return true;
    const policy = task.rules?.blockingFailures || {};
    return policy[signalName] === true;
  }

  timeline.push("Parsed task requirements");
  timeline.push(`Classified media as ${metrics.kind || "unknown"}`);

  const kindWeight = 10;
  total += kindWeight;
  if (metrics.kind === task.mediaKind) {
    earned += kindWeight;
    checks.push({
      label: "Media type",
      status: "pass",
      detail: `Matched ${task.mediaKind}`,
      weight: kindWeight
    });
  } else {
    checks.push({
      label: "Media type",
      status: "fail",
      detail: `Expected ${task.mediaKind}, received ${metrics.kind || "unknown"}`,
      weight: kindWeight
    });
    blockers.push("Wrong media type for this collection task");
  }

  if (task.mediaKind === "image" || task.mediaKind === "video") {
    const resolutionResult = scoreResolution(metrics, task, checks);
    addResult(resolutionResult, "Resolution is below task requirement", "Resolution needs review");

    if (typeof task.rules.minBlurScore === "number") {
      const blurResult = scoreMin(
        metrics.blurScore,
        task.rules.minBlurScore,
        "Sharpness",
        8,
        checks,
        blockingForVisualSignal("sharpness")
      );
      blurResult.weight = 8;
      addResult(blurResult, "Media is too blurry for training", "Sharpness needs review");
    }

    const brightnessResult = scoreRange(
      metrics.brightness,
      task.rules.brightnessMin,
      task.rules.brightnessMax,
      "Exposure",
      6,
      checks,
      false
    );
    brightnessResult.weight = 6;
    addResult(brightnessResult, null, "Exposure is outside preferred range");
  }

  if (task.mediaKind === "video" || task.mediaKind === "audio") {
    const durationResult = scoreRange(
      metrics.durationSec,
      task.rules.minDurationSec,
      task.rules.maxDurationSec,
      "Duration",
      8,
      checks,
      true
    );
    durationResult.weight = 8;
    addResult(durationResult, "Duration is outside task limits", "Duration needs review");
  }

  if (task.mediaKind === "audio") {
    const rmsResult = scoreMin(metrics.rms, task.rules.minRms, "Audio level", 12, checks, true);
    rmsResult.weight = 12;
    addResult(rmsResult, "Audio level is too low", "Audio level needs review");

    const silenceResult = scoreRange(
      metrics.silenceRatio,
      0,
      task.rules.maxSilenceRatio,
      "Silence ratio",
      10,
      checks,
      false
    );
    silenceResult.weight = 10;
    addResult(silenceResult, null, "Recording has a high silence ratio");
  }

  const duplicate = findDuplicate(
    metrics.perceptualHash,
    previousHashes,
    task.rules.duplicateHammingMax
  );
  total += 8;
  if (duplicate) {
    checks.push({
      label: "Duplicate check",
      status: "fail",
      detail: `Similar to ${duplicate.fileName} (distance ${duplicate.distance})`,
      weight: 8
    });
    blockers.push("Submission appears to duplicate an earlier file");
  } else {
    earned += 8;
    checks.push({
      label: "Duplicate check",
      status: metrics.perceptualHash ? "pass" : "review",
      detail: metrics.perceptualHash ? "No close match in current batch" : "No perceptual hash",
      weight: 8
    });
    if (!metrics.perceptualHash) reviewReasons.push("Duplicate signal unavailable");
  }

  timeline.push("Ran deterministic media checks");

  const semanticSignals = reviewerSignals.semantic || {};
  const semanticConfidence = reviewerSignals.confidence;
  const required = task.rules.semanticRequired || [];
  let semanticScoreCap = null;
  const promptMatchRequired = task.mediaKind === "audio" && required.includes("prompt_match");
  let semanticPassed = 0;
  let semanticKnown = 0;
  let semanticUnknown = 0;
  for (const signal of required) {
    if (semanticSignals[signal] === true) {
      semanticPassed += 1;
      semanticKnown += 1;
    } else if (semanticSignals[signal] === false) {
      semanticKnown += 1;
    } else {
      semanticUnknown += 1;
    }
  }

  const semanticWeight = 60;
  total += semanticWeight;
  if (required.length === 0) {
    earned += semanticWeight;
  } else if (semanticKnown === 0) {
    earned += semanticWeight * 0.35;
    reviewReasons.push("Semantic task compliance requires model or human review");
    checks.push({
      label: "Task compliance",
      status: "review",
      detail: "No semantic model result attached",
      weight: semanticWeight
    });
  } else {
    const semanticRatio = semanticPassed / required.length;
    const taskSpecificSignals = required.filter((signal) => isTaskSpecificVisualSignal(signal, task));
    const taskSpecificPassed = taskSpecificSignals.filter((signal) => semanticSignals[signal] === true).length;
    const highConfidenceVisual =
      (task.mediaKind === "image" || task.mediaKind === "video") &&
      typeof semanticConfidence === "number" &&
      semanticConfidence >= 0.82 &&
      semanticRatio >= 0.6;
    const unknownCredit = highConfidenceVisual
      ? Math.min(semanticUnknown, Math.max(0, required.length - semanticPassed)) * 0.75
      : 0;
    const inferredCount = Math.floor(unknownCredit / 0.75);
    const effectiveSemanticRatio = Math.min(1, (semanticPassed + unknownCredit) / required.length);
    const semanticScore = semanticWeight * effectiveSemanticRatio;
    earned += semanticScore;
    checks.push({
      label: "Task compliance",
      status: effectiveSemanticRatio >= 0.8 ? "pass" : effectiveSemanticRatio >= 0.5 ? "review" : "fail",
      detail: inferredCount > 0
        ? `${semanticPassed}/${required.length} required signals matched, ${inferredCount} inferred from high model confidence`
        : `${semanticPassed}/${required.length} required signals matched`,
      weight: semanticWeight
    });
    if (effectiveSemanticRatio < 0.5) {
      blockers.push("Submission does not match required scene or prompt");
      semanticScoreCap = taskMismatchScoreCap(effectiveSemanticRatio);
    }
    if ((task.mediaKind === "image" || task.mediaKind === "video") && taskSpecificSignals.length > 0 && taskSpecificPassed === 0) {
      blockers.push("Submission is missing the task-specific subject or action");
      semanticScoreCap = Math.min(semanticScoreCap ?? 100, 10);
    }
    if (promptMatchRequired && semanticSignals.prompt_match === false) {
      blockers.push("Audio does not match the required spoken prompt");
      semanticScoreCap = Math.min(semanticScoreCap ?? 100, 10);
    }
    if (effectiveSemanticRatio >= 0.5 && effectiveSemanticRatio < 0.8) {
      reviewReasons.push("Task compliance confidence is medium");
    }
  }

  const privacySignals = reviewerSignals.privacy || {};
  const privacyFlags = Object.entries(privacySignals)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  if (privacyFlags.length > 0) {
    reviewReasons.push(`Privacy signals found: ${privacyFlags.join(", ")}`);
  }

  timeline.push("Built evidence pack");

  const rawScore = clamp(Math.round((earned / Math.max(total, 1)) * 100), 0, 100);
  const score = semanticScoreCap === null ? rawScore : Math.min(rawScore, semanticScoreCap);
  let verdict = "needs_review";
  if (blockers.length > 0 || score < task.thresholds.reviewScore) {
    verdict = "rejected";
  } else if (reviewReasons.length === 0 && score >= task.thresholds.acceptScore) {
    verdict = "accepted";
  }

  if (verdict === "needs_review") timeline.push("Routed to human review");
  if (verdict === "accepted") timeline.push("Cleared for dataset ingestion");
  if (verdict === "rejected") timeline.push("Rejected with auditable hard-failure evidence");

  return {
    verdict,
    score,
    confidence: clamp(score / 100, 0.05, 0.98),
    blockers,
    reviewReasons,
    checks,
    timeline,
    summary: buildSummary(verdict, score, blockers, reviewReasons)
  };
}

function isTaskSpecificVisualSignal(signal, task) {
  if (task.mediaKind !== "image" && task.mediaKind !== "video") return false;
  const normalized = normalizeSignal(signal);
  if (/^(pov|first_person|first_person_pov|first_person_perspective|camera_perspective)$/.test(normalized)) return false;
  if (/^(hands?|hands_visible|hand_visible|legs?|legs_visible|leg_visible|feet_visible|body_visible|limbs_visible)$/.test(normalized)) return false;
  if (/^(visible|present|clear|sharp|natural_scene|outdoor_scene)$/.test(normalized)) return false;
  return true;
}

function normalizeSignal(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildSummary(verdict, score, blockers, reviewReasons) {
  if (verdict === "accepted") {
    return `Accepted with quality score ${score}. The submission satisfies all configured gates.`;
  }
  if (verdict === "rejected") {
    return `Rejected with quality score ${score}. ${blockers[0] || "Hard quality gate failed."}`;
  }
  return `Needs human review with quality score ${score}. ${
    reviewReasons[0] || "One or more signals require reviewer judgement."
  }`;
}

module.exports = { evaluateSubmission, hammingHex };
