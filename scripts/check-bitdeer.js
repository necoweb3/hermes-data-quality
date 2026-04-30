const path = require("path");
const dotenv = require("dotenv");
const { BitdeerProvider } = require("../src/providers/bitdeer");

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

async function main() {
  const provider = new BitdeerProvider();
  const status = provider.describe();

  console.log("Bitdeer configuration");
  console.log(`- baseUrl: ${status.baseUrl}`);
  console.log(`- model: ${status.model || "not set"}`);
  console.log(`- key: ${status.enabled ? "present" : "missing"}`);

  const models = await provider.listModels();
  console.log(`\nmodels endpoint: ${models.ok ? "ok" : "not ok"} (${models.status})`);
  if (!models.ok) {
    console.log(`  ${models.error}`);
    return;
  }

  const ids = extractModelIds(models.payload);
  const filtered = ids.filter((id) => /nemotron|vl|vision|nvidia/i.test(id)).slice(0, 20);
  if (filtered.length > 0) {
    console.log("\nmatching models:");
    for (const id of filtered) console.log(`- ${id}`);
  } else {
    console.log("\nNo obvious NVIDIA/VL model ids found in the first response.");
  }

  if (process.argv.includes("--vision")) {
    const result = await provider.evaluateFrame({
      task: {
        name: "POV dishwashing video",
        objective: "Hands, sink, dishes, and continuous dishwashing action should be visible.",
        rules: { semanticRequired: ["pov", "hands", "sink", "dishes", "continuous_action"] }
      },
      metrics: { kind: "image", width: 1280, height: 960, brightness: 50, blurScore: 25 },
      imageDataUrl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/1280px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"
    });

    console.log(`\nvision call: ${result.ok ? "ok" : "not ok"} (${result.status})`);
    if (!result.ok) {
      console.log(`  ${result.error}`);
      return;
    }
    const content = result.payload?.choices?.[0]?.message?.content || "";
    console.log(`  ${content.slice(0, 420).replace(/\s+/g, " ")}`);
  }

  if (process.argv.includes("--vision-string")) {
    const result = await provider.chatCompletion([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image? Answer in one sentence." },
          {
            type: "image_url",
            image_url:
              "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/1280px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"
          }
        ]
      }
    ]);

    console.log(`\nvision string call: ${result.ok ? "ok" : "not ok"} (${result.status})`);
    if (!result.ok) {
      console.log(`  ${result.error}`);
      return;
    }
    const content = result.payload?.choices?.[0]?.message?.content || "";
    console.log(`  ${content.slice(0, 420).replace(/\s+/g, " ")}`);
  }

  if (process.argv.includes("--vision-dataurl")) {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const result = await provider.chatCompletion([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image? Answer in one sentence." },
          { type: "image_url", image_url: { url: tinyPng } }
        ]
      }
    ]);

    console.log(`\nvision data-url call: ${result.ok ? "ok" : "not ok"} (${result.status})`);
    if (!result.ok) {
      console.log(`  ${result.error}`);
      return;
    }
    const content = result.payload?.choices?.[0]?.message?.content || "";
    console.log(`  ${content.slice(0, 420).replace(/\s+/g, " ")}`);
  }

  if (process.argv.includes("--text")) {
    const result = await provider.chatCompletion(
      [{ role: "user", content: 'Return JSON only: {"ok":true,"note":"hello"}' }],
      { max_tokens: 80, temperature: 0 }
    );

    console.log(`\ntext call: ${result.ok ? "ok" : "not ok"} (${result.status})`);
    if (!result.ok) {
      console.log(`  ${result.error}`);
      return;
    }
    const content = result.payload?.choices?.[0]?.message?.content || "";
    console.log(`  ${content.slice(0, 240).replace(/\s+/g, " ")}`);
  }
}

function extractModelIds(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.data)) {
    return payload.data.map((item) => item.id || item.name || item.model).filter(Boolean);
  }
  if (Array.isArray(payload.models)) {
    return payload.models.map((item) => item.id || item.name || item.model || item).filter(Boolean);
  }
  return [];
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
