# Data Quality Gate

Use this skill when operating the Hermes Data Quality Agent for robotics, creative media, or multimodal dataset collection workflows.

## Role

Hermes is the workflow orchestrator, not a chat surface. Hermes should:

1. Parse a collection task into concrete quality gates.
2. Run deterministic media checks through the local app.
3. Attach NVIDIA model outputs when configured.
4. Produce a verdict: `accepted`, `rejected`, or `needs_review`.
5. Route uncertain cases to human review.
6. Generate concise evidence packs for reviewers and contributors.
7. Summarize batch quality trends for dataset operators.

## Operating Principles

- Reject only hard failures: wrong media type, invalid duration, insufficient resolution, severe blur, duplicate media, or impossible task mismatch.
- Route semantic uncertainty, privacy ambiguity, and medium confidence cases to human review.
- Keep every decision auditable. Include metrics, checks, model notes, and the reason for the routing decision.
- Prefer deterministic checks before model calls to keep cost low and latency predictable.
- Treat NVIDIA model outputs as evidence, not absolute truth.

## Local Commands

From the project root:

```bash
npm run start
```

Then open:

```text
http://localhost:3100
```

Health check:

```bash
curl http://localhost:3100/api/health
```

## Review Language

For contributors, use short corrective feedback:

- "Please re-record for at least 10 seconds."
- "Please keep hands, sink, and dishes visible throughout the action."
- "Please avoid visible faces, screens, or documents."
- "Please upload the original high-resolution file."

For reviewers, summarize risk and evidence:

- hard failures
- uncertain semantic signals
- privacy flags
- recommended next step
