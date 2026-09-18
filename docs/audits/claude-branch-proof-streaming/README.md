# Claude transcript branch-proof allocation

Production implementation with preserved intermediate experiments. The proof reads the current source and reconstructs the original reader by reversing `fix.patch` in memory; it does not modify checkout files. The `windowCandidate` result key now names the actual production implementation.

The original main-process branch reader loads the complete JSONL file, splits every line, and retains the source while constructing the ancestry graph. Message bodies are discarded after each parse. This is transient allocation, not evidence of memory retained after the proof returns.

## Reproduce

From the primary checkout with its existing dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/claude-branch-proof-streaming/reproduce.cjs /tmp/claude-branch-streaming-results.json
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/claude-branch-proof-streaming/regressions.mjs /tmp/claude-branch-streaming-regressions.json
```

No install, Electron window, network call, or product edit occurs. The existing `diff` package reverses the patch, and the original source hash plus unique experiment anchors reject drift. Modules are built with the installed esbuild into a temporary directory, loaded with normal `require`, and removed with their require-cache entries in `finally`. The original allocation observation is preserved in `baseline-initial-results.json`; subsequent comparisons do not overwrite it.

## Production reachability and version

- `structured-agent-session-runtime.ts:287` constructs the local Claude runtime adapter in main. The adapter's `readTranscriptLeaf` resolves the pinned account's `projects` transcript and calls `session-file-resolver.ts:168`, which delegates to the full branch proof.
- `claude-structured-session-close.ts:100` first awaits successful connection close, then reads the transcript at line 116 before persisting the handle and removing the session. A failed proof preserves the previously observed leaf. `claude-structured-session-adapter.ts:182` also invokes this reader when persisting a handle after unexpected exit.
- `orca-runtime-stop-structured-session-process.ts:184` calls the full reader during local resumed-PTY verification. A torn final record retries on a 100ms cadence within its 15-second deadline, re-reading the file. These are sequential reads; the proof does not establish accumulating retained copies or the actual number of attempts in any incident.
- The unrestricted `readFile` and close/resume wiring already exist in **v1.4.198**. The resume verifier is identical in that tag. Current explicit rewind handling was added later; it is a current compatibility control, not attributed to the tag. `provenance.json` records both versions' source hashes and exact call-site lines.

This is source reachability and synthetic allocation evidence. No affected user's transcript size, concurrent-close count, or triggering call is known, so it does not independently explain #19831 or another reported OOM.

## Candidates and complete proof semantics

Both candidates extract the existing parser and final graph validation into one accumulator shared by the synchronous string API and asynchronous file reader. They reuse `splitTranscriptStreamLines` with its default unlimited record size. Every UUID remains in the metadata graph; the existing 10,000-ancestor limit remains unchanged. No file-size quota, record limit, tail-only selection, or message eviction is added.

`candidate-transform.json` is the initial **open-ended stream** experiment. It reduces allocation on static files, but changes concurrent-append observations and is not suitable for promotion as written.

`window-candidate-transform.json` preserves the reviewed **same-handle initial-byte window** experiment that was promoted: open once, stat that handle, stream bytes 0 through initial size minus one, and await handle closure in `finally`. An initially empty prefix fails the existing missing-marker proof without opening a stream. This bounds the observation to a finite prefix without imposing a fixed transcript quota. The stream never reopens a pathname after stat. The current proof and regressions execute the checked-out production implementation for this variant.

The current window candidate then handles two specific absence errors: an internal typed missing-marker error (public name/text unchanged) or the existing missing-previous-cursor error. Only if a second stat of that same open handle proves growth does it report `ClaudeTranscriptTailIncompleteError`, allowing the existing caller retry. Failed stat, shrink, no growth, path replacement, and static invalid files retain the original error. Parser conflicts, wrong sessions, global append order, ancestry, and rewind failures are never reclassified. A successful prefix stays successful without observing later rows. The initial window-only experiment and its liveness gap are preserved separately in `initial-window-candidate-transform.json` and `initial-window-results.json`.

The shared graph still checks duplicate UUID conflicts, every node's append order (including disconnected branches), old ancestry, sidechains, session identity, last marker ordering, missing previous cursor, and intentional rewind. UTF-8 decoding and terminated versus unterminated record information come from the existing line splitter. Malformed middle records remain ordinary errors; an invalid unterminated final record remains `ClaudeTranscriptTailIncompleteError`.

## Concurrent append boundary

This is an explicit race-behavior change, not exact emulation of Node's read chunk sizes. On Node 26.6.0, the actual UTF-8 `readFile` excludes appended rows for a small file or an exactly 512KiB prefix, but includes them for a tested 512KiB+100B prefix or an initially empty file. The open-ended candidate admits them in every case. The window candidate consistently uses the initial byte prefix.

The source's existing append-only-snapshot proof contract supports that finite prefix. An appended marker cannot repair a prefix with a missing previous cursor/marker or incomplete final record. A previously proved descendant or intentional rewind remains tied to that prefix even if a newer marker is appended during reading. This does not provide an atomic filesystem snapshot: concurrent in-place mutation/truncation can still change bytes inside the window, as with the existing reader.

Caller behavior differs by error: the TUI resume verifier retries only `ClaudeTranscriptTailIncompleteError`; a static missing marker is fatal there. The separate `readClaudeTranscriptLeafWithReproof` wrapper may retry a static missing previous cursor from the root. Growth classification keeps the original cursor during a retry instead of triggering that root reproof while new bytes arrive. Close catches proof errors and preserves the previously observed leaf. The candidate adds no timer or retry loop; it reuses the existing incomplete-tail classification only on the two growth-proven absence failures. An append after the final stat can still miss this observation; no atomic filesystem snapshot or retry guarantee is claimed.

The active-writer ordering is reachable: fresh TUI launch waits for idle and a recent matching provider hook but has no transcript flush barrier; recovery and reproof invoke the same verifier on a live owner without an idle wait. No captured CLI transcript establishes how often an initially empty file occurs at exactly this boundary. The artifact's 10 verifier cases execute the exact current method body with controlled live-owner, hook, and path-resolution ports, the actual branch reader, and the actual 100ms timer. Growing empty/missing-marker/missing-previous cases succeed on attempt two. Static absence and growing conflict/session/order failures stay fatal on attempt one. This is an actual-method fixture, not a full running Claude process.

`growth.cjs` injects real-file append, rename/replacement, deletion, and truncation after the native stat captures its size (or before the first read for the open-ended experiment). It also injects stat/read failures. Actual descriptor closure is checked. The initial open-ended reader closes asynchronously after an early parse error; the window candidate awaits closure before resolving/rejecting, including empty/error cases. The fixture uses a private Node binding only to make these timing boundaries deterministic; it is not production code or a public API proposal.

## Evidence and limits

`results.json` contains 51 static real-file cases compared across file and string APIs for all three variants, 24 growth/lifecycle controls, 10 verifier cases, and sampled allocation. `regression-results.json` records 68 existing resolver, rewind, structured recovery, and history-window tests passing on each source variant (204 tests total).

The production regression file, `src/main/claude/claude-transcript-branch-streaming.test.ts`, adds 23 focused real-file tests for prefix bounds, UTF-8/old ancestors, growth classification, successful rewind, malformed data, handle identity, and awaited cleanup. The reused splitter/framer already exists unchanged in main commit `291b4ddd6f`; unrelated source-budget additions to `decodeTranscriptStream` are not required by this change.

The allocation fixture writes real files incrementally, uses realistic 36-character UUIDs and session IDs, then invokes the actual bundled reader. Forced GC at each actual `JSON.parse` boundary measures live bytes while the source is in use. A 32MiB file containing 64 bodies of 512KiB needs about **34.6MB** additional live heap in the original reader versus about **1.2MB** in the streaming candidates. After return, both release nearly all of that allocation. Exact figures and source/bundle hashes are recorded in JSON.

This is not RSS, a natural peak, or a throughput benchmark; sampling excludes the native read buffer's possible peak before parsing. GC noise can make retained deltas negative. A single 8MiB record still uses about **16.8MB** under all variants. The complete UUID graph still grows with record count, and exceptionally large identity strings remain accepted. Streaming bounds retained message payload to the largest current record plus framing buffers; it is not a total memory cap. This proof does not justify any new quota or incident attribution.

A separate simple duration control reads one stable 2.79MB file containing 8,193 small records. It uses two warm rounds and five measured rounds in alternating order, without GC during timing. Node 26 medians were 7.92ms before and 10.06ms after; installed Electron's Node 24 medians were 5.09ms and 6.84ms. This is a modest absolute cost and measurable per-line overhead, not a throughput guarantee. Per-run durations are included rather than setting a fragile timing gate.

`electron-results.json` repeats the real-file proof under installed Electron 43.7.0 in `ELECTRON_RUN_AS_NODE=1` mode (Node 24.21.0), with no app/window launch. All proof controls pass there too. This is compatibility evidence for the installed runtime, not the exact historical Electron 43.4.1 / Node 24.18.1 binary. On this macOS checkout the command is:

```sh
ELECTRON_RUN_AS_NODE=1 ORCA_BACKGROUND_LAUNCH=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc docs/audits/claude-branch-proof-streaming/reproduce.cjs /tmp/claude-branch-streaming-electron.json
```

Other platforms should use their installed Electron executable with the same environment and arguments. No package installation is needed.

Existing tail-window readers are not substitutes: they omit old ancestors, conflicts, or global append-order evidence. The similarly named `claude-tui-exit.ts` leaf reader finds a tail marker without establishing this full graph proof.

## Follow-up: finish already-appended proof repairs internally

The published initial-window version `ff8411085a4b588ca313672a53957c1d7e9a7aa5` is the version measured by the artifacts above. The current reader now retries one enlarged finite prefix on the same descriptor when the first prefix is missing a marker/cursor or ends in a partial record, and a second descriptor stat proves that bytes were appended. A complete valid original prefix still returns immediately; a malformed/conflicting/session/order failure is never retried. The refreshed prefix undergoes the entire existing proof again.

This avoids making a caller wait and re-open merely to see bytes that already arrived. An unfinished repair remains the existing incomplete-tail result after one refresh; continually growing incomplete sources can still require a caller retry. The reader does not wait for a producer, chase an unlimited stream, infer growth from a path replacement, or weaken the proof. Regression cases cover all three missing-prefix shapes, completed partial records, invalid repairs, retry bounds, successful unchanged prefixes, and descriptor closure. The original standalone artifact scripts are historical and require their pinned source revision.
