const test = require("node:test");
const assert = require("node:assert/strict");
const { getTask } = require("./tasks");
const {
  aggregateVisualSignals,
  mergeSignals,
  parseAsrEvidence,
  parseVisualObservationEvidence,
  parseVisionComplianceEvidence,
  textSimilarity
} = require("./modelSignals");

test("parses vision compliance json into semantic and privacy signals", () => {
  const task = getTask("pov-dishwashing");
  const result = {
    ok: true,
    payload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              task_match_score: 0.82,
              visible_required_elements: {
                pov: true,
                hands: true,
                sink: true,
                dishes: false,
                continuous_action: true
              },
              privacy_flags: {
                faces: false,
                documents: true
              },
              reviewer_next_step: "Route to review because documents are visible."
            })
          }
        }
      ]
    }
  };

  const signals = parseVisionComplianceEvidence(result, task);

  assert.equal(signals.semantic.pov, true);
  assert.equal(signals.semantic.dishes, false);
  assert.equal(signals.privacy.faces, false);
  assert.equal(signals.privacy.documents, true);
  assert.equal(signals.confidence, 0.82);
});

test("low task match score marks required signals false when explicit signals are absent", () => {
  const task = getTask("group-photo-4k");
  const signals = parseVisionComplianceEvidence(
    {
      ok: true,
      payload: {
        choices: [{ message: { content: '{"task_match_score": 0.12, "privacy_flags": {}}' } }]
      }
    },
    task
  );

  assert.equal(signals.semantic.multiple_people, false);
  assert.equal(signals.semantic.natural_scene, false);
});

test("infers parkour motion hints from non-exact vision wording", () => {
  const task = {
    rules: {
      semanticRequired: [
        "first_person_pov",
        "hands_visible",
        "legs_visible",
        "dynamic_camera_motion",
        "parkour_trick_or_movement"
      ],
      privacyReviewSignals: []
    }
  };

  const signals = parseVisionComplianceEvidence(
    {
      ok: true,
      payload: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                task_match_score: 0.72,
                visible_required_elements: {
                  first_person_pov: true,
                  hands_visible: true
                },
                reviewer_next_step:
                  "The contact sheet shows legs and shoes while the camera moves through a parkour vault and jump sequence."
              })
            }
          }
        ]
      }
    },
    task
  );

  assert.equal(signals.semantic.legs_visible, true);
  assert.equal(signals.semantic.dynamic_camera_motion, true);
  assert.equal(signals.semantic.parkour_trick_or_movement, true);
});

test("softens ambiguous false limb signals for video evidence", () => {
  const task = {
    mediaKind: "video",
    rules: {
      semanticRequired: ["first_person_pov", "hands_visible", "legs_visible"],
      privacyReviewSignals: []
    }
  };

  const signals = parseVisionComplianceEvidence(
    {
      ok: true,
      payload: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                task_match_score: 0.74,
                visible_required_elements: {
                  first_person_pov: true,
                  hands_visible: false,
                  legs_visible: false
                },
                reviewer_next_step: "Contact sheet has partial limb visibility; route to reviewer."
              })
            }
          }
        ]
      }
    },
    task
  );

  assert.equal(signals.semantic.first_person_pov, true);
  assert.equal(signals.semantic.hands_visible, null);
  assert.equal(signals.semantic.legs_visible, null);
});

test("promotes high-confidence ambiguous action labels for video evidence", () => {
  const task = {
    mediaKind: "video",
    rules: {
      semanticRequired: [
        "first_person_perspective",
        "active_parkour_maneuver",
        "hands_visible",
        "legs_visible",
        "obstacle_interaction"
      ],
      privacyReviewSignals: []
    }
  };

  const signals = parseVisionComplianceEvidence(
    {
      ok: true,
      payload: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                task_match_score: 0.8,
                visible_required_elements: {
                  first_person_perspective: true,
                  active_parkour_maneuver: false,
                  hands_visible: true,
                  legs_visible: true,
                  obstacle_interaction: false
                },
                rejection_risks: ["active_parkour_maneuver_missing"]
              })
            }
          }
        ]
      }
    },
    task
  );

  assert.equal(signals.semantic.active_parkour_maneuver, true);
  assert.equal(signals.semantic.obstacle_interaction, true);
  assert.match(signals.notes.join(" "), /High-confidence/);
});

test("promotes high-confidence generic visual action labels", () => {
  const task = {
    mediaKind: "video",
    name: "POV cleaning video",
    objective: "Collect POV cleaning clips where hands interact with the requested object.",
    rules: {
      semanticRequired: ["first_person_pov", "hands_visible", "object_interaction", "continuous_action"],
      privacyReviewSignals: []
    }
  };

  const signals = parseVisionComplianceEvidence(
    {
      ok: true,
      payload: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                task_match_score: 0.86,
                scene_summary: "A first-person clip shows hands cleaning an object across several frames.",
                visible_required_elements: {
                  first_person_pov: true,
                  hands_visible: true,
                  object_interaction: false,
                  continuous_action: null
                }
              })
            }
          }
        ]
      }
    },
    task
  );

  assert.equal(signals.semantic.object_interaction, true);
  assert.equal(signals.semantic.continuous_action, true);
});

test("does not promote sensitive or count labels from confidence alone", () => {
  const task = {
    mediaKind: "image",
    name: "Group photo",
    objective: "Collect a natural image with multiple people.",
    rules: {
      semanticRequired: ["multiple_people", "natural_scene"],
      privacyReviewSignals: []
    }
  };

  const signals = parseVisionComplianceEvidence(
    {
      ok: true,
      payload: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                task_match_score: 0.9,
                scene_summary: "An outdoor natural scene is visible.",
                visible_required_elements: {
                  multiple_people: false,
                  natural_scene: true
                }
              })
            }
          }
        ]
      }
    },
    task
  );

  assert.equal(signals.semantic.multiple_people, false);
  assert.equal(signals.semantic.natural_scene, true);
});

test("merges reviewer and model signals while preserving positive evidence", () => {
  const merged = mergeSignals(
    { semantic: { hands: true }, privacy: { faces: false } },
    { semantic: { hands: false, sink: true }, privacy: { faces: true }, confidence: 0.7 }
  );

  assert.deepEqual(merged.semantic, { hands: true, sink: true });
  assert.deepEqual(merged.privacy, { faces: true });
  assert.equal(merged.confidence, 0.7);
});

test("clear visual task mismatch forces required signals false", () => {
  const task = {
    mediaKind: "video",
    rules: {
      semanticRequired: ["first_person_perspective", "hands_visible", "active_parkour_maneuver"],
      privacyReviewSignals: []
    }
  };

  const signals = parseVisionComplianceEvidence(
    {
      ok: true,
      payload: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                task_match_score: 0.18,
                wrong_subject_or_activity: true,
                scene_summary: "A static camera shows an animal walking near a tree.",
                visible_required_elements: {
                  first_person_perspective: true
                }
              })
            }
          }
        ]
      }
    },
    task
  );

  assert.equal(signals.semantic.first_person_perspective, false);
  assert.equal(signals.semantic.hands_visible, false);
  assert.equal(signals.semantic.active_parkour_maneuver, false);
  assert.match(signals.notes.join(" "), /clear task mismatch/);
});

test("task-agnostic visual observation vetoes unrelated parkour acceptance", () => {
  const task = {
    mediaKind: "video",
    name: "pov_parkour_videos",
    objective: "Collect first-person parkour/freerunning videos where hands and legs are visible.",
    rules: {
      semanticRequired: [
        "first_person_perspective",
        "active_parkour_maneuver",
        "hands_visible",
        "legs_visible",
        "obstacle_interaction"
      ],
      privacyReviewSignals: []
    }
  };
  const compliance = [
    {
      semantic: {
        first_person_perspective: true,
        active_parkour_maneuver: true,
        hands_visible: true,
        legs_visible: true,
        obstacle_interaction: true
      },
      privacy: {},
      confidence: 0.92,
      notes: []
    }
  ];
  const observation = parseVisualObservationEvidence({
    ok: true,
    payload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              scene_summary: "A static camera shows a large lizard walking beside a tree.",
              subjects: ["animal", "lizard"],
              actions: ["walking"],
              objects: ["tree"],
              camera_perspective: "fixed third-person camera"
            })
          }
        }
      ]
    }
  });

  const signals = aggregateVisualSignals({ task, signals: compliance, observations: [observation] });

  assert.equal(signals.semantic.active_parkour_maneuver, false);
  assert.equal(signals.semantic.obstacle_interaction, false);
  assert.equal(signals.confidence, 0.1);
  assert.match(signals.notes.join(" "), /did not show task anchors/);
});

test("task-agnostic visual observation allows grounded parkour evidence", () => {
  const task = {
    mediaKind: "video",
    name: "pov_parkour_videos",
    objective: "Collect first-person parkour/freerunning videos where hands and legs are visible.",
    rules: {
      semanticRequired: [
        "first_person_perspective",
        "active_parkour_maneuver",
        "hands_visible",
        "legs_visible",
        "obstacle_interaction"
      ],
      privacyReviewSignals: []
    }
  };
  const compliance = [
    {
      semantic: {
        first_person_perspective: true,
        active_parkour_maneuver: true,
        hands_visible: true,
        legs_visible: true,
        obstacle_interaction: true
      },
      privacy: {},
      confidence: 0.9,
      notes: []
    },
    {
      semantic: {
        first_person_perspective: true,
        active_parkour_maneuver: true,
        hands_visible: true,
        legs_visible: true,
        obstacle_interaction: true
      },
      privacy: {},
      confidence: 0.88,
      notes: []
    }
  ];
  const observation = parseVisualObservationEvidence({
    ok: true,
    payload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              scene_summary: "First-person frames show a person running and jumping over a wall or rail.",
              subjects: ["person"],
              actions: ["running", "jumping", "vaulting"],
              objects: ["wall", "rail"],
              visible_body_parts: ["hands", "legs"]
            })
          }
        }
      ]
    }
  });

  const signals = aggregateVisualSignals({ task, signals: compliance, observations: [observation] });

  assert.equal(signals.semantic.active_parkour_maneuver, true);
  assert.equal(signals.semantic.obstacle_interaction, true);
  assert.ok(signals.confidence > 0.85);
});

test("parses ASR transcript into prompt match signal", () => {
  const task = getTask("voice-prompt");
  const signals = parseAsrEvidence(
    {
      ok: true,
      payload: {
        transcript: "The robot places the clean cup on the top shelf."
      }
    },
    task
  );

  assert.equal(signals.semantic.prompt_match, true);
  assert.ok(signals.confidence > 0.9);
  assert.match(signals.transcript, /robot places/);
});

test("extracts quoted audio prompt and derives audio quality signals", () => {
  const task = {
    mediaKind: "audio",
    promptText: 'Please say exactly: "Hello, I am your financial advisor." Speak once, clearly, at a natural pace.',
    rules: {
      semanticRequired: [
        "contains_exact_sentence",
        "single_speaker",
        "clear_speech",
        "minimal_background_noise",
        "prompt_match"
      ],
      minDurationSec: 1,
      maxDurationSec: 6,
      minRms: 0.015,
      maxSilenceRatio: 0.45
    }
  };

  const signals = parseAsrEvidence(
    {
      ok: true,
      payload: {
        transcript: "Hello, I am your financial advisor."
      }
    },
    task,
    {
      durationSec: 3,
      rms: 0.1887,
      silenceRatio: 0.3767
    }
  );

  assert.equal(signals.semantic.prompt_match, true);
  assert.equal(signals.semantic.contains_exact_sentence, true);
  assert.equal(signals.semantic.single_speaker, true);
  assert.equal(signals.semantic.clear_speech, true);
  assert.equal(signals.semantic.minimal_background_noise, true);
  assert.ok(signals.confidence > 0.95);
});

test("text similarity drops for unrelated transcript", () => {
  const score = textSimilarity(
    "The robot places the clean cup on the top shelf.",
    "A person talks about weekend travel plans."
  );

  assert.ok(score < 0.4);
});
