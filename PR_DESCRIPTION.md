## Summary

Proposal: an `orca terminal command` verb that sends one slash command into a Claude Code terminal with a typed contract. It refuses before writing a byte when Enter would mean something else in the target's current state. When it does write, it reports what the session did with the command. It answers suggestion 2 of #17836 for the Claude Code slice only.

It extends the guarded two-phase send Orca already has. The invariant it protects: an Enter never reaches a terminal whose input owner is unproven. The trade-off it accepts: a refusal costs the caller one retry.

Measured on Orca v1.4.209 (public release, tag commit `e4d8a9dbc2`) and Claude Code 2.1.280, macOS arm64, on fresh throwaway sessions. Code anchors are `path:line` at `dac82f61bc`. Every cited file is unchanged at `main` `519bde81df`.

## Problem

`orca terminal send` has two write paths, and neither fits a slash command.

* **Text plus** `--enter` **in one call** becomes an agent prompt (`src/cli/handlers/terminal-send.ts:17`). The runtime frames the text as a bracketed paste (`src/shared/agent-prompt-injection.ts:121`) and waits for a turn start (`src/main/runtime/orca-runtime-write-terminal-agent-prompt.ts:121`). Claude Code does not parse a slash command out of a paste: `/goal <body>` sent this way landed as pasted content inside an ordinary prompt, and no goal was registered.
* **Text alone, then a bare** `--enter` writes raw bytes (`src/main/runtime/terminal-send-payload.ts:6`). This delivers today (13 of 13 runs across `/compact`, `/goal`, `/rename` and `/color`, see the annex), but only by convention, and the Enter call returns `accepted: true, bytesWritten: 1` whatever the session did with it.

The gap is the receipt and the guards, not the delivery.

1. **No receipt.** The agent-prompt verifier accepts one kind of evidence, a turn start. `/rename` and `/color` never start a turn, so a correct send through that path reads as `agent_prompt_stalled` (`src/main/runtime/agent-prompt-submission-verification.ts:11`, #15976). #22472 draws the same line for prompts: `accepted` means the host took the bytes, nothing more.
2. **No guard on the CLI.** A bare Enter is read by whatever owns the input at that moment. With a permission prompt open, it approves the pending tool call. With an AskUserQuestion modal open, it selects the highlighted option. With text already staged in the composer, it submits that text. This is ordinary terminal behavior, and it is the reason the guarded send below exists. The CLI does not expose that guard, so every script that sends a slash command in two writes carries the exposure. Measured details are in the annex.

Related: #17836 (slash commands through `terminal send`, suggests this verb), #15976 (false stall on submissions that start no turn), #17066 (stall on injected prompts), #22034 (route inter-agent messages to Claude Code through its native inter-session channel instead of terminal input; its first failure mode is a message lost behind an open modal), #22472 (`delivery.verdict` on `terminal send`), #22079 (transcript read hardening).

## Starting point: the guarded two-phase send

Orca already refuses the dangerous shape. With `requireAgentStatus: 'sendable'`, `terminal.send` rejects text plus Enter in one call ("guarded sends are two-phase", `src/main/runtime/rpc/methods/terminal/terminal-send-method.ts:130`) and rechecks permission and agent presence immediately before the PTY write (`:140`). The renderer builds on it in `sendPromptWithGuardedPasteAndEnter` (`src/renderer/src/lib/active-agent-note-send-delivery.ts:49`): a guarded paste, a readiness recheck, then a guarded bare Enter.

So the first answer to #17836 is "expose the guard in the CLI". That answer is necessary, and this proposal starts there. It is not sufficient for a slash command, for three reasons:

1. Phase 1 of the renderer path is a bracketed paste (`active-agent-note-send-delivery.ts:70`). A slash command has to arrive as raw bytes.
2. Between the phases the renderer waits a fixed 50 ms (`src/renderer/src/lib/agent-paste-draft.ts:36`) and rechecks the agent status. The status does not show text someone else staged in the composer, and whether an open AskUserQuestion always surfaces as `permission` is open question 3.
3. The guarded Enter returns `accepted`. A command that starts no turn needs its own receipt.

The proposal is therefore two layers:

* **Layer 1, small and independent:** a `--guarded` flag on `terminal send` that sets `requireAgentStatus: 'sendable'`. The CLI then offers the same two guarded calls the renderer uses. It can land first.
* **Layer 2, this verb:** a composition of the same two guarded RPC calls, with raw bytes instead of a paste, a composer check and an interactive-wait check before the Enter, and a receipt.

## CLI contract

```
orca terminal command [--terminal <handle>] --command <name>
                      [--args <text> | --args-file <path>]
                      [--wait-receipt <seconds>] [--require-draft] [--json]
```

* `--command`: the name, with or without the leading `/`, validated against `^[A-Za-z0-9][A-Za-z0-9:_-]*$`. Plugin commands such as `plugin:name` pass. Anything else is refused with zero bytes written.
* `--args` / `--args-file`: optional argument text. `--args-file` closes a real gap: a body read from a file today goes through `--text " $(cat file)"`, which strips the final newline. Args containing CR (`\r`) or ESC (`\x1b`) are refused, because either byte can submit or reframe the input halfway through. LF is allowed.
* `--wait-receipt <seconds>`: observe the session for up to N seconds after the Enter (maximum 3600, the `--wait-submit` bound). Default 0. Waiting never resends.
* `--require-draft`: refuse the Enter when the composer cannot be read back (see "Composer check").
* `--terminal` resolves exactly as in `terminal send`.

JSON result on success:

```json
{
  "ok": true,
  "result": {
    "command": {
      "handle": "term_...",
      "name": "compact",
      "argsBytes": 0,
      "selfTarget": false,
      "writes": [
        { "kind": "command", "bytes": 8 },
        { "kind": "submit", "bytes": 1 }
      ],
      "preflight": { "agentStatus": "working", "composer": "empty", "interactiveWait": null },
      "draftCheck": "match",
      "receipt": { "stage": "queued", "source": "transcript", "record": "enqueue" }
    }
  }
}
```

`receipt.stage` is one of:

| Stage | Meaning |
| -- | -- |
| `input_accepted` | bytes written, nothing observed yet |
| `queued` | the session queued the command behind a running turn |
| `executed` | a command-specific record appeared (`custom-title`, `agent-color`, `goal_status`, `compact_boundary`) |
| `unverifiable` | no receipt source is readable; delivery is still reported |

`input_accepted` and `unverifiable` mean exactly what they mean in #22472's `delivery.verdict` (head `764cb2dd2b`). `turn_started` is not used: `/rename` and `/color` start no turn, and `/compact` runs at the next turn boundary. `queued` and `executed` are the two stages a slash command adds.

Refusals return `ok: false`, `bytesWritten: 0`, and one `error.code`:

| `error.code` | Trigger |
| -- | -- |
| `invalid_argument` | bad name, CR or ESC in args, both `--args` and `--args-file` |
| `unsupported_agent` | the foreground agent is not Claude Code |
| `agent_awaiting_permission` | a permission prompt is open |
| `agent_awaiting_answer` | an AskUserQuestion modal is open |
| `composer_not_empty` | the composer holds staged text |
| `composer_not_observable` | the composer cannot be read before write 1 |
| `agent_status_unknown` | the status could not be read in time (fail closed) |
| `incompatible_runtime` | the host predates the verb |

Exit codes: `0` sent, whatever the receipt stage; `1` refused, or the Enter was withheld mid-sequence. An earlier draft had an exit 3 for "sent, not confirmed". It is dropped. #22472 keeps exit 0 for `input_accepted` on purpose: an unobserved stage is unproven, not failed, and a non-zero exit would make ordinary sends look broken. A sibling verb with another exit convention would split every caller that handles both. The caller reads `receipt.stage`. A stage below `executed` never means failure: the command may still run at the next turn boundary, so the caller must not resend.

## Guards

Each check runs again immediately before every write. The gap between two CLI writes was measured at 0.3 to 2.7 s, and a permission prompt can open inside it.

* **Permission prompt.** The existing guard: `requireAgentStatus: 'sendable'` (`src/shared/rpc-contract/terminal-unary-params.ts:116`) refuses on `permission` (`src/main/runtime/rpc/terminal-agent-send-guard.ts:29`) and fails closed when no agent is proven within about one second (`:36`). Result: `agent_awaiting_permission`, zero bytes.
* **AskUserQuestion modal.** Claude's hook reports it as a `waiting` state carrying the tool name (`src/main/agent-hooks/server/server-status-inference.ts:59`), and newer Claude versions send it as a PermissionRequest (`src/main/agent-hooks/server/server-claude-status-rules.ts:69`). The verb refuses when the status is `permission` or when `getTerminalInteractiveWait` reports any wait (`src/main/runtime/orca-runtime-get-terminal-interactive-wait.ts:19`). Result: `agent_awaiting_answer`, zero bytes.
* **Staged composer text.** See "Composer check".
* **State flips mid-sequence.** If a check fails after write 1, the verb withholds the Enter and returns `ok: false` with the blocking `error.code`, `bytesWritten` above zero and `stagedText: true`. It does not clear the composer (open question 6).
* **Self-send.** The CLI knows its own terminal: `ORCA_TERMINAL_HANDLE`, validated live through `terminal.resolveIdentity` as the orchestration verbs already do (`src/cli/handlers/orchestration/terminal-identity.ts:18`). The runtime compares the PTY behind that handle with the PTY behind the resolved `--terminal`, so a reminted handle still matches. `selfTarget` is `true`, `false` or `unknown` (no handle in the environment). When `true`, a turn-boundary command such as `/compact` or `/goal` cannot complete before the caller's own turn ends. The wait then stops at `queued`, and the result says so. `/rename` and `/color` still reach `executed`: their records land between the caller's tool call and its result. When `unknown`, the bounded `--wait-receipt` window is the only protection, and the result says that too.

## Composer check

The draft is a rebuild from the screen, and it can differ from the typed bytes. `detectTerminalComposerDraft` (`src/shared/terminal-composer-draft.ts:181`) rebuilds it from the rendered screen, from at most one screen of rows above the cursor (`src/main/daemon/headless-emulator.ts:326`). It joins soft-wrapped rows without a separator, keeps hard breaks as `\n`, trims the edges of each line, then trims the whole (`terminal-composer-draft.ts:150`). The tail projection computes it at `src/main/runtime/orca-runtime-terminal-projection.ts:12`. It folds it into the tail only when the view sits at the bottom of the buffer (`:13`). A byte-exact comparison fails on a multi-line body, and a body taller than the screen yields no draft at all.

The contract is therefore:

* **Three composer states.** The detector returns `null` both for an empty composer and for a composer it cannot find (`terminal-composer-draft.ts:160`). The runtime needs a three-state read: `empty`, `text`, or `unobservable`. It is a small addition beside the existing function, whose signature stays as it is.
* **Before write 1** the composer must read `empty`. `text` refuses with `composer_not_empty`, `unobservable` with `composer_not_observable`.
* **Normalized comparison before the Enter.** `norm(s) = s.replace(/\s+/g, ' ').trim()`, the normalization the detector already applies to placeholder text (`terminal-composer-draft.ts:92`). Expected text is `/<name>`, plus `" " + args` when present.
  * `match`, `norm(draft) === norm(expected)`: send the Enter.
  * `mismatch`, a draft is read and differs: withhold the Enter, `stagedText: true`.
  * `unobservable`, no draft (the prompt row sits more than one screen above the cursor, or the view is scrolled): the fallback.
* **Fallback.** Send the Enter only if the composer read `empty` before write 1, every write was accepted, and both guards pass immediately before the Enter. The result carries `draftCheck: "unobservable"`, so the caller knows the composer was not re-read. What the fallback cannot rule out is a keystroke typed by someone else between write 1 and the Enter. `--require-draft` turns the fallback into a refusal for callers who prefer to fail closed.
* **Settle between writes.** After each write, poll the composer until it reads `match`, or until a bounded timeout. When it reads `unobservable`, wait a 300 ms floor, the gap measured sufficient, and continue. This replaces the renderer's fixed 50 ms with an observation where one is possible.

**Worked case:** `/goal` **with a 2,914-byte, three-paragraph body.** Before write 1 the composer reads `empty`. Write 1 is `/goal`, and the draft reads `/goal`: `match`. Write 2 is `" " + body`. On a pane tall enough to show the whole body under the prompt, the normalized draft equals the normalized expected text. Wraps are joined, and the paragraph breaks collapse to one space on both sides. `match`, Enter. On a shorter pane the prompt row scrolls out of the one-screen window, the draft reads `unobservable`, and the fallback applies: empty before write 1, both writes accepted, guards pass, Enter, `draftCheck: "unobservable"`. Both paths submit, which is what the measured three-write runs did with no check at all (3 of 3 goals registered, body byte-identical).

## Receipt source

The receipt reads the session transcript only through the existing Claude transcript readers, never a bare open of `transcriptPath`. They are `src/main/claude/claude-tui-exit.ts`, `src/main/claude/claude-transcript-branch-proof.ts`, and the gated access in `src/main/native-chat/wsl-transcript-fs-access.ts`. Those readers still open with a plain `'r'` (`claude-tui-exit.ts:44`, `claude-transcript-branch-proof.ts:96`). #22079 (open, head `c63fdf2215`) adds `O_NOFOLLOW | O_NONBLOCK` against symlink swaps and FIFO stalls. It supersedes #22463, closed as its duplicate. The receipt parser lands after #22079, or carries the same open flags. A record from another session id is ignored. An unreadable transcript yields `unverifiable`, never `executed`. Hook events stay the preferred source where one exists (open question 2).

## Where it lives upstream

* Layer 1: `--guarded` on `terminal send`, mapping to the existing `requireAgentStatus` parameter.
* CLI: new `src/cli/specs/terminal-command.ts` and `src/cli/handlers/terminal-command.ts`, registered beside `terminal send` (`src/cli/handler-group-manifest.ts:86`, `src/cli/handlers/terminal.ts:116`, `src/cli/specs/core.ts:231`, `src/cli/root-help-text-secondary.ts:65`). The capability check copies `src/cli/handlers/terminal-send.ts:41`.
* RPC: a `terminal.command` method next to `terminal-send-method.ts:130`, its schema beside `TerminalSend` (`terminal-unary-params.ts:102`), its result beside `RuntimeTerminalSend` (`src/shared/runtime-terminal-contracts.ts:208`).
* Reused: `assertTerminalAgentSendable` (`terminal-agent-send-guard.ts:12`), `sendTerminal` for raw writes (`src/main/runtime/orca-runtime-controller-knows-pty-is-live.ts:90`), `buildTerminalSendPayload`, the composer detector, the transcript readers above, and the `transcriptPath` the hook server records (`src/main/agent-hooks/server/server-types.ts:72`).
* Not reused: the agent-prompt path (`terminal-send-method.ts:192`). Its paste framing and its turn-start verifier are the two behaviors that break slash commands.

## Tests

Each guard test is first shown red against a variant that skips the guard, as CONTRIBUTING asks for tests that catch a regression.

* CLI handler, in the style of `src/cli/handlers/terminal.test.ts:467`: flag parsing, name validation, CR and ESC refusal, `--args` with `--args-file` refused, no RPC call on any refusal.
* RPC method: `permission` gives zero writes and `agent_awaiting_permission`; an AskUserQuestion wait gives `agent_awaiting_answer`; a non-empty composer gives `composer_not_empty`; a status flip between write 1 and the Enter writes no `\r`; a `mismatch` draft writes no `\r`; an `unobservable` draft with `--require-draft` writes no `\r`; the writes are exactly `/name`, ` args`, `\r`, separately, with no `\x1b[200~`; a non-Claude agent gives `unsupported_agent`.
* Composer check: fixture screens for a wrapped body, a body with blank lines, a body taller than the screen, and a scrolled view, asserting `match`, `match`, `unobservable`, `unobservable`.
* Receipt parser, on fixture transcript lines: `enqueue` and `dequeue`, `custom-title`, `agent-color`, `goal_status`, `compact_boundary`. A record from another session id is ignored; an unreadable transcript yields `unverifiable`.
* A manual matrix reproducing the annex runs on macOS, Linux and an SSH host.

## Backward compatibility

* Additive: a new flag, a new verb, a new RPC method, new optional types. `terminal send` keeps its contract byte for byte without `--guarded`.
* An older host is detected through a runtime capability, as `--wait-submit` does. The CLI refuses with `incompatible_runtime` and writes nothing. It never falls back to unguarded writes.
* The receipt reads records whose format belongs to Claude Code. A missing or unknown record degrades to `input_accepted` or `unverifiable`, never to a false `executed` and never to a false failure.

## Open questions for the maintainers

1. **Where does the guard live on the CLI?** Starting from the existing two-phase guard, three options. (A) `--guarded` on `terminal send`, plus `terminal command` built on it. (B) `--guarded` only: callers compose the slash sequence themselves, so raw bytes, the composer check and the receipt are rewritten in every caller. (C) a `--slash` mode on `terminal send`, which mixes two receipt contracts in one verb. The proposal prefers A: the guard lands as a small change of its own, and the sequencing that callers get wrong lives in one place.
2. Receipt source: the session transcript (measured, but a provider-private format), hook events, or both with hooks preferred?
3. On current Claude Code, does an open AskUserQuestion map to `permission` in the agent status, or should the verb rely on `getTerminalInteractiveWait` alone?
4. Is the three-state composer read an acceptable change to `terminal-composer-draft.ts`, or should it live in the runtime?
5. Scope: Claude Code first, with Codex and OMP (the palette case in #17836) as follow-ups?
6. After an Enter withheld on staged text, should the verb clear the composer, which needs a key-event surface such as suggestion 3 in #17836, or leave it and report it?

<details>
<summary>Annex: measurements and timings</summary>

All runs on Orca v1.4.209 and Claude Code 2.1.280, macOS arm64, fresh throwaway sessions.

**The two-write convention delivers.**

| Command | Writes | Result |
| -- | -- | -- |
| `/compact` sent mid-turn | 2 | 4 of 4 queued about 110 ms after the Enter, executed at the turn boundary, `compact_boundary` with `"trigger":"manual"` |
| `/goal` with a body | 3 | 3 of 3 goals registered, body byte-identical up to 2,914 bytes, zero pasted-content blocks |
| `/rename` | 2 | 3 of 3 `custom-title` records; the name shows in `terminal list` and in the resume picker |
| `/color` | 2 | 3 of 3 `agent-color` records |

Control: `--text "/goal <772-byte body>" --enter` in one call landed as a pasted-content block inside an ordinary prompt, and no goal was registered (1 of 1).

**What a bare Enter does today, by target state.**

| Target state | What happened to the text | What the bare Enter did |
| -- | -- | -- |
| Permission prompt open | lost, no trace | approved the pending tool call (its result landed 753 ms later) |
| AskUserQuestion modal open | lost, no trace | selected the highlighted option (answer recorded 151 ms later, indistinguishable from a deliberate choice) |
| Text already staged in the composer | n/a | submitted the staged text as a prompt; it was invisible on the rendered screen, exposed only by the `draft` field |
| `--wait-submit` with a bare Enter | n/a | refused client-side before any runtime call (`src/cli/handlers/terminal-send.ts:20`), so the two-write convention cannot ask for a receipt |

**Timings.**

* Gaps of 272 to 310 ms between writes (one CLI round trip, no deliberate delay) were sufficient at 772 and at 2,914 bytes. Gaps of 2.6 s also worked. No lower bound was reached, so the measured requirement is separate writes, with no deliberate wait between them.
* `/compact` sent mid-turn: `enqueue` record 106 to 122 ms after the Enter, `dequeue` 10 to 20 ms after the turn's `turn_duration` record, then `compact_boundary`.
* `/rename`: `custom-title` seen 219 ms after the Enter write started in one run, 47 ms after the Enter call returned in the other. `/color`: `agent-color` 159 to 322 ms after the Enter.
* Self-send: the `custom-title` and `agent-color` records land between the sending tool call and its result.
* Inside the runtime the gaps shrink below one CLI round trip, which was not measured.

</details>
