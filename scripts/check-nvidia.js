const path = require("path");
const dotenv = require("dotenv");
const { NvidiaProvider } = require("../src/providers/nvidia");

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

async function main() {
  const provider = new NvidiaProvider();
  const status = provider.describe();

  console.log("NVIDIA configuration");
  for (const [kind, info] of Object.entries(status.models)) {
    console.log(
      `- ${kind}: ${info.model || "not set"} / ${info.configured ? "key present" : "not configured"}`
    );
  }

  const checks = [
    [
      "pii",
      () =>
        provider.detectPii(
          "Jane Doe can be reached at jane@example.com while recording the kitchen task."
        )
    ],
    [
      "policy",
      () =>
        provider.explainVerdict({
          task: { id: "voice-prompt", objective: "Record a clean prompted sentence." },
          metrics: { kind: "audio", durationSec: 5.1, rms: 0.04, silenceRatio: 0.12 },
          verdict: { verdict: "needs_review", score: 81 }
        })
    ],
    [
      "safety",
      () =>
        provider.checkContentSafety({
          text: "Dataset submission: a person is washing dishes in a kitchen. Check for unsafe content."
        })
    ]
  ];

  for (const [name, run] of checks) {
    try {
      const result = await run();
      console.log(`\n${name}: ${result.ok ? "ok" : "not ok"} (${result.status})`);
      if (!result.ok) console.log(`  ${result.error}`);
    } catch (error) {
      console.log(`\n${name}: error`);
      console.log(`  ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
