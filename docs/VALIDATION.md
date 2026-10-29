# Validation — 0.7.0-alpha.1

This is a preview release. Results describe the tested configuration and synthetic tasks; they are not a general success rate.

## Accepted checks

| Scope | Result | Limits |
|---|---|---|
| Latest source regression | 156 passed, 0 skipped | Local automated tests |
| macOS V4 AX controls | Passed | Dedicated synthetic AppKit window only |
| V4 DSH with real model | Passed: 6 desktop calls, 0 tool errors | One task; independent application output confirmed one save |
| V4 packed installation | Passed: clean install, actual DSH, 6 calls | Local scripted provider; static Saved: 1 was visible |
| History-index repair | Passed: 8 actual DSH browser calls | Local scripted provider; index ID used to recall original detail observation |
| Earlier Native long flows | Passed with 51 and 77 successful observations | Before the history-index addition; independent model trajectories |

The desktop tests verified Chinese text input, a single save, a model-visible static success label, protected-value exclusion, reference invalidation after an action, and rejection of a renamed control. The real-model run and packed-installation test both independently confirmed exactly one save. Browser tests used isolated Chromium Headless Shell 153.0.8010.12 with Playwright 1.63.0, without personal Chrome profiles.

## Retained failures and reduced test scope

- A PTC long flow was stopped after repeated guessed history IDs (including 118 HISTORY_NOT_FOUND and 10 IMAGE_HISTORY_NOT_FOUND outcomes). A paginated history index was added and verified with unit tests, failure-session replay and the short actual-DSH test. A repaired real-model PTC long flow has **not** been completed.
- A later Native sample completed 49 successful observations. It passed the other 13 long-flow checks but failed the required minimum of 50. That sample remains a failure; earlier passing samples do not erase it.
- Later desktop rechecks returned an application shell without window controls. After the user confirmed an unlocked desktop, V4 direct tests, renamed-control tests, actual DSH tests and the packed-installation test passed. This sequence does not prove the sole cause of the earlier failure.
- An initial packed-package evaluation failed because npm omits package-lock.json. Provenance now records a null fingerprint and unavailable_files rather than inventing a hash; a regression test covers this case. The corrected packed installation passed the DSH desktop check.
- Offline installs initially failed due to missing npm cache entries; registry installation succeeded using a project-local cache. No global cache permissions were changed.

The user requested fewer tests. Repeated full regressions and the remaining four-way long-flow comparison were therefore stopped. No additional API credential was requested for the final local short check. PTC history trimming, duplicate compaction, image window/pins and budget diagnostics remain experimental and default off. The reported Native peak request inputs (60,328 and 79,710 tokens) came from different trajectories and are **not** evidence of cost savings.

## Unsupported or unverified scope

Desktop screenshots, global mouse/keyboard input, desktop PTC, arbitrary application coverage, notarized helper distribution, and every AX cancellation race are not supplied or verified. AXConfirm is a semantic control action, not global keyboard input. The desktop helper reads values only from static status labels, excluding editable and protected values. Business completion must still be checked in the target application.

Budget status is an estimate of committed context, not a complete final-request token limit. Full autonomous PTC long-flow reliability after the index repair remains unverified. Other DSH/provider/platform versions may behave differently.

## Publication privacy scope

The public tree contains source, synthetic fixtures, setup guides and summarized results. Internal continuation notes, raw provider/session logs, captured images, environment files, caches, generated helpers and old archives are excluded. An unused captured provider replay fixture was also excluded. The export has a new Git history and uses a verified GitHub noreply commit address.

All staged files were checked for common credential patterns and personal absolute paths; file scope and commit metadata were reviewed separately. Such checks do not prove the absence of every possible sensitive string. Public GitHub account identity remains visible.
