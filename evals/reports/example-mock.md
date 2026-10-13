# Eval report: mock / mock-heuristic-v1

Run: 2026-10-13T08:36:36.473Z  |  Cases: 40  |  Gate: category accuracy >= 80% -> **PASS**

| Metric | Value |
| --- | --- |
| Category accuracy | 88% |
| Meaningful (yes/no) accuracy | 95% |
| Severity accuracy (meaningful, category correct) | 63% |
| Avg latency per LLM call | 0 ms |
| Total cost (estimated) | $0.0000 |
| Resolved by deterministic pre-filter (no LLM call) | 9 / 40 |
| Provider errors | 0 |

| Category | Support | Precision | Recall |
| --- | --- | --- | --- |
| price | 6 | 86% | 100% |
| availability | 6 | 100% | 100% |
| policy | 5 | 100% | 60% |
| content | 5 | 56% | 100% |
| outage | 5 | 100% | 80% |
| noise | 13 | 100% | 85% |

## Misses (5)

| Case | Expected | Got | Source |
| --- | --- | --- | --- |
| policy-03 | policy | content | llm |
| policy-04 | policy | content | llm |
| outage-05 | outage | content | llm |
| noise-05 | noise | price | llm |
| noise-09 | noise | content | llm |
