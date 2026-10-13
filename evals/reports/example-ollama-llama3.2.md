# Eval report: ollama / llama3.2

Run: 2026-10-13T08:48:41.644Z  |  Cases: 40  |  Gate: category accuracy >= 80% -> **PASS**

| Metric | Value |
| --- | --- |
| Category accuracy | 88% |
| Meaningful (yes/no) accuracy | 93% |
| Severity accuracy (meaningful, category correct) | 46% |
| Avg latency per LLM call | 1856 ms |
| Total cost (estimated) | $0.0000 |
| Resolved by deterministic pre-filter (no LLM call) | 9 / 40 |
| Provider errors | 0 |

| Category | Support | Precision | Recall |
| --- | --- | --- | --- |
| price | 6 | 100% | 100% |
| availability | 6 | 100% | 100% |
| policy | 5 | 83% | 100% |
| content | 5 | 56% | 100% |
| outage | 5 | 100% | 80% |
| noise | 13 | 100% | 69% |

## Misses (5)

| Case | Expected | Got | Source |
| --- | --- | --- | --- |
| outage-04 | outage | policy | llm |
| noise-05 | noise | content | llm |
| noise-08 | noise | content | llm |
| noise-09 | noise | content | llm |
| noise-13 | noise | content | llm |
