const TASKS = [];

const TEST_TASKS = [
  {
    id: "pov-dishwashing",
    name: "POV dishwashing video",
    collection: "Robotics manipulation",
    mediaKind: "video",
    objective:
      "Capture a continuous first-person dishwashing sequence with hands, sink, dishes, and running water visible.",
    rules: {
      minDurationSec: 10,
      maxDurationSec: 30,
      minWidth: 1080,
      minHeight: 720,
      minBlurScore: 16,
      brightnessMin: 18,
      brightnessMax: 88,
      duplicateHammingMax: 6,
      semanticRequired: ["pov", "hands", "sink", "dishes", "continuous_action"],
      privacyReviewSignals: ["faces", "screens", "documents"]
    },
    thresholds: {
      acceptScore: 82,
      reviewScore: 58
    }
  },
  {
    id: "group-photo-4k",
    name: "4K group photo",
    collection: "Vision alignment",
    mediaKind: "image",
    objective:
      "Provide a sharp high-resolution photo containing a group of people, suitable for rights-cleared training data.",
    rules: {
      minWidth: 3840,
      minHeight: 2160,
      minBlurScore: 18,
      brightnessMin: 20,
      brightnessMax: 86,
      duplicateHammingMax: 5,
      semanticRequired: ["multiple_people", "natural_scene"],
      privacyReviewSignals: ["faces", "children", "badges", "documents"]
    },
    thresholds: {
      acceptScore: 84,
      reviewScore: 60
    }
  },
  {
    id: "voice-prompt",
    name: "Prompted voice recording",
    collection: "Speech dataset",
    mediaKind: "audio",
    objective:
      "Record the requested sentence clearly with one primary speaker and low background noise.",
    promptText: "The robot places the clean cup on the top shelf.",
    rules: {
      minDurationSec: 3,
      maxDurationSec: 18,
      minRms: 0.015,
      maxSilenceRatio: 0.38,
      duplicateHammingMax: 4,
      semanticRequired: ["prompt_match"],
      privacyReviewSignals: ["background_voice", "private_information"]
    },
    thresholds: {
      acceptScore: 80,
      reviewScore: 56
    }
  }
];

function getTask(taskId) {
  return TEST_TASKS.find((task) => task.id === taskId) || TEST_TASKS[0];
}

module.exports = { TASKS, TEST_TASKS, getTask };
