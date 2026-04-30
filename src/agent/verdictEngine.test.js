const test = require("node:test");
const assert = require("node:assert/strict");
const { getTask } = require("./tasks");
const { evaluateSubmission, hammingHex } = require("./verdictEngine");

test("rejects wrong media type", () => {
  const task = getTask("pov-dishwashing");
  const result = evaluateSubmission({
    task,
    metrics: { kind: "image", width: 1920, height: 1080, blurScore: 30, brightness: 50 },
    previousHashes: []
  });

  assert.equal(result.verdict, "rejected");
  assert.match(result.blockers.join(" "), /Wrong media type/);
});

test("routes semantically unknown but technically good video to review", () => {
  const task = getTask("pov-dishwashing");
  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "video",
      width: 1920,
      height: 1080,
      durationSec: 14,
      blurScore: 32,
      brightness: 54,
      perceptualHash: "ff00ff00ff00ff00"
    },
    previousHashes: []
  });

  assert.equal(result.verdict, "needs_review");
  assert.ok(result.reviewReasons.length > 0);
});

test("routes motion-blurry videos to review instead of rejecting", () => {
  const task = getTask("pov-dishwashing");
  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "video",
      width: 1920,
      height: 1080,
      durationSec: 14,
      blurScore: 14.2,
      brightness: 54,
      perceptualHash: "ff00ff00ff00ff00"
    },
    previousHashes: [],
    reviewerSignals: {
      semantic: {
        pov: true,
        hands: true,
        sink: true,
        dishes: true,
        continuous_action: true
      },
      privacy: {
        faces: false,
        screens: false,
        documents: false
      }
    }
  });

  assert.equal(result.verdict, "needs_review");
  assert.match(result.reviewReasons.join(" "), /Sharpness/);
});

test("rejects technically valid video when task compliance is low", () => {
  const task = getTask("pov-dishwashing");
  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "video",
      width: 1920,
      height: 1080,
      durationSec: 14,
      blurScore: 32,
      brightness: 54,
      perceptualHash: "ff00ff00ff00ff00"
    },
    previousHashes: [],
    reviewerSignals: {
      semantic: {
        pov: true,
        hands: null,
        sink: null,
        dishes: null,
        continuous_action: null
      },
      privacy: {
        faces: false,
        screens: false,
        documents: false
      }
    }
  });

  assert.equal(result.verdict, "rejected");
  assert.equal(result.score, 10);
  assert.match(result.blockers.join(" "), /does not match/);
});

test("caps completely unrelated task matches near zero", () => {
  const task = getTask("pov-dishwashing");
  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "video",
      width: 1920,
      height: 1080,
      durationSec: 14,
      blurScore: 32,
      brightness: 54,
      perceptualHash: "ff00ff00ff00ff00"
    },
    previousHashes: [],
    reviewerSignals: {
      semantic: {
        pov: false,
        hands: false,
        sink: false,
        dishes: false,
        continuous_action: false
      },
      privacy: {}
    }
  });

  assert.equal(result.verdict, "rejected");
  assert.equal(result.score, 0);
});

test("caps generic visual matches when task-specific action is missing", () => {
  const task = {
    mediaKind: "video",
    rules: {
      minWidth: 1280,
      minHeight: 720,
      brightnessMin: 18,
      brightnessMax: 88,
      minDurationSec: 5,
      maxDurationSec: 120,
      duplicateHammingMax: 6,
      semanticRequired: [
        "first_person_perspective",
        "hands_visible",
        "active_parkour_maneuver",
        "obstacle_interaction"
      ],
      privacyReviewSignals: []
    },
    thresholds: {
      acceptScore: 82,
      reviewScore: 58
    }
  };

  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "video",
      width: 1920,
      height: 1080,
      durationSec: 13,
      blurScore: 32,
      brightness: 54,
      perceptualHash: "ff00ff00ff00ff00"
    },
    previousHashes: [],
    reviewerSignals: {
      semantic: {
        first_person_perspective: true,
        hands_visible: true,
        active_parkour_maneuver: false,
        obstacle_interaction: false
      },
      privacy: {}
    }
  });

  assert.equal(result.verdict, "rejected");
  assert.equal(result.score, 10);
  assert.match(result.blockers.join(" "), /task-specific/);
});

test("accepts clean audio when ASR confirms exact spoken prompt", () => {
  const task = {
    mediaKind: "audio",
    rules: {
      duplicateHammingMax: 6,
      semanticRequired: [
        "contains_exact_sentence",
        "single_speaker",
        "clear_speech",
        "minimal_background_noise",
        "prompt_match"
      ],
      privacyReviewSignals: [],
      minDurationSec: 1,
      maxDurationSec: 6,
      minRms: 0.015,
      maxSilenceRatio: 0.45
    },
    thresholds: {
      acceptScore: 82,
      reviewScore: 58
    }
  };

  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "audio",
      durationSec: 3,
      rms: 0.1887,
      silenceRatio: 0.3767,
      perceptualHash: "0011223344556677"
    },
    previousHashes: [],
    reviewerSignals: {
      semantic: {
        contains_exact_sentence: true,
        single_speaker: true,
        clear_speech: true,
        minimal_background_noise: true,
        prompt_match: true
      },
      privacy: {},
      confidence: 1
    }
  });

  assert.equal(result.verdict, "accepted");
  assert.ok(result.score >= 90);
});

test("rejects clean audio when spoken prompt does not match", () => {
  const task = {
    mediaKind: "audio",
    rules: {
      duplicateHammingMax: 6,
      semanticRequired: ["clear_speech", "minimal_background_noise", "prompt_match"],
      privacyReviewSignals: [],
      minDurationSec: 1,
      maxDurationSec: 6,
      minRms: 0.015,
      maxSilenceRatio: 0.45
    },
    thresholds: {
      acceptScore: 82,
      reviewScore: 58
    }
  };

  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "audio",
      durationSec: 3,
      rms: 0.1887,
      silenceRatio: 0.2,
      perceptualHash: "0011223344556677"
    },
    previousHashes: [],
    reviewerSignals: {
      semantic: {
        clear_speech: true,
        minimal_background_noise: true,
        prompt_match: false
      },
      privacy: {},
      confidence: 0.2
    }
  });

  assert.equal(result.verdict, "rejected");
  assert.equal(result.score, 10);
  assert.match(result.blockers.join(" "), /spoken prompt/);
});

test("accepts portrait video when long and short sides satisfy landscape requirement", () => {
  const task = getTask("pov-dishwashing");
  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "video",
      width: 1080,
      height: 1920,
      durationSec: 14,
      blurScore: 32,
      brightness: 54,
      perceptualHash: "ff00ff00ff00ff00"
    },
    previousHashes: [],
    reviewerSignals: {
      semantic: {
        pov: true,
        hands: true,
        sink: true,
        dishes: true,
        continuous_action: true
      },
      privacy: {
        faces: false,
        screens: false,
        documents: false
      }
    }
  });

  assert.notEqual(result.verdict, "rejected");
  assert.equal(result.checks.find((check) => check.label === "Resolution").status, "pass");
});

test("accepts strong video when semantic and privacy signals pass", () => {
  const task = getTask("pov-dishwashing");
  const result = evaluateSubmission({
    task,
    metrics: {
      kind: "video",
      width: 1920,
      height: 1080,
      durationSec: 14,
      blurScore: 32,
      brightness: 54,
      perceptualHash: "ff00ff00ff00ff00"
    },
    previousHashes: [],
    reviewerSignals: {
      semantic: {
        pov: true,
        hands: true,
        sink: true,
        dishes: true,
        continuous_action: true
      },
      privacy: {
        faces: false,
        screens: false,
        documents: false
      }
    }
  });

  assert.equal(result.verdict, "accepted");
});

test("computes hamming distance for hex hashes", () => {
  assert.equal(hammingHex("f0", "ff"), 4);
});
