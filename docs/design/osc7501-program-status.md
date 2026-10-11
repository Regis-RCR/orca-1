# OSC 7501 program status

This note records why Orca reads the Program Status Protocol (OSC 7501) the way it does: the
problem, what the protocol and a real capture constrain, the architecture, compatibility, scope,
the alternatives that were rejected and the known limits. The code is the reference for details;
this note is about the choices.

## Problem

Orca shows an agent's state (working, waiting, done) from per-agent hooks, OSC 9999 and terminal
title heuristics. Agents without hooks or a recognizable title show nothing, and title parsers
break when an agent changes its title format.

OSC 7501 lets a program report its own state through the PTY: `idle`, `working`, `blocked` (with
`kind=permission|question|auth`), `done`, `error`, plus child records for subagents. Agent CLIs
that wait for feature detection, including the one whose captured transcripts ship in
`src/main/runtime/__fixtures__`, report only after the terminal answers the support probe
`OSC 7501 ; ?`. Orca did not answer it, so inside Orca they sent nothing.

## What the protocol and a capture constrain

The spec (rev 0.4, superlogical.com/rex/docs/build/program-status) fixes:

- A report is `key=value` pairs separated by `:`. A malformed pair is skipped, unknown keys are
  ignored, the last duplicate wins, and a report that breaks a limit (4096 bytes per sequence,
  key, msg, title, app and id sizes, strict base64 that decodes as UTF-8, no control characters)
  is discarded whole.
- A report replaces its record; `clear` removes a record and its subtree; at most 256 records per
  terminal. A prompt start (OSC 133;A) drops `working` and `blocked`; RIS drops everything. When the
  attached process exits, `working` and `blocked` go and `done` and `error` survive.
- There is no heartbeat: a terminal must not require re-sending to keep a record alive, and the
  terminal decides when to stop showing a result.
- Detection is optional: a program may report without probing. Everything in a report is
  untrusted input from a program that already controls the screen.
- The probe reply must start with `?` and may spell out the supported states and kinds; a reply
  without them means the default sets.

Where the spec is silent, the code follows Ghostty's reading: a bare ESC ends a report before that
ESC, base64 with non-canonical trailing bits is rejected, `progress` takes any digit count up to
100 and only with `working` or `blocked`, and a store holding only `idle` children aggregates to
`idle`.

Six transcripts of a reporting agent CLI (version 2.1.295, macOS) are committed in
`src/main/runtime/__fixtures__` and replayed by tests. The captures confirm the protocol's
detection and interruption rules and expose additional implementation-specific behavior. The
design depends on each point:

- **The probe must be answered before DA1.** At startup the agent writes XTVERSION, the Kitty
  keyboard query, the 7501 probe and DA1 in one write. If the DA1 reply arrives first, the agent
  decides support is absent, never probes again and never reports. A late 7501 reply is useless.
- **`done` arrives twice**: once bare, then again about two seconds later with a summary message.
  The second one must not count as a new transition.
- **An interrupt reports `idle`**, not `error` or `done`.
- **Exit sends three root `clear` reports** back to back, so a `done` does not outlive the agent
  that sent it unless the program stops without clearing.
- **Subagent ids are flat**: a 17 character hex id, not a `parent/child` path. A child carries a
  `title` and ends with `clear:id=...`, never with `done`.

## Architecture

The work splits into a pure core, with no production caller in the first pull request, and its
integration (second pull request).

### Pure core

`src/shared/program-status/` holds the parser, a chunk-split-safe stream scanner, the per-terminal
record store, the projection (the aggregate a status dot shows, the root's own state, and whether a
child failed), and a tracker that runs them for one PTY incarnation. The tracker numbers each
change of what it would publish with a `reportSeq` and gives each of its two views (now, and what
remains once the process exits) a generation that is never reused, before any throttling. An equal
`reportSeq` therefore always means an identical observation, and a dismissed state that went and
came back inside one throttle window still carries a new generation. Emission is throttled per PTY
(a burst of 8, then 20 per second) and the latest state is always delivered.

### One store, one producer slot per pane

`AGENTS.md` asks that agent status live in one store, the hook server's, with every reader
subscribing to it and producers writing into it. OSC 7501 is a new producer, so it writes into that
store. Each pane gets a second slot beside today's hook row: the hook row is unchanged, the
program-status slot is new, and neither ever writes the other. Each slot has its own acceptance
rule, closure record and dismissal, so the lifecycle of one producer never erases the other's
state. The slot is published on the existing agent-status channel as its own row type; it is never
a hook row, never persisted, and never part of the default status snapshot or the status file.

### Where the bytes are read: the PTY owner, before thinning

The tracker runs in the process that owns the PTY bytes, so hidden, backgrounded and not yet
mounted panes are covered:

- **Local provider:** main tracks the PTY directly.
- **Persistent daemon:** the session runs its own tracker on the startup ingress output, in byte
  order and before the keep-tail thinning of backgrounded sessions, so dropped bytes never lose a
  report. Each change is relayed as a new `program-status` kind inside the existing `transientFact`
  event, carrying the session incarnation, the `reportSeq` and both dated views. The
  `createOrAttach` reply carries a snapshot, so the first state after an app restart is not lost.

In main, a pure ledger per PTY keeps the registered incarnation, the highest `reportSeq`, the latest
observation and the lifecycle phase. It applies a fact only for the registered incarnation and a
greater `reportSeq`, holds facts that overtake their control reply until the incarnation registers,
and turns each event into at most one report write and one lifecycle write. The ingress attributes
each PTY to a pane with the rule OSC 9999 already uses and writes into the hook server store.

### The probe, answered at the startup ingress, before DA1

The PTY owner's startup ingress already answers colour queries synchronously in the parse turn that
reads them. It now answers the 7501 probe the same way. Every DA1 answerer (the renderer, and the
daemon's own answer while the shell-ready barrier holds) sits downstream of it, so the 7501 reply is
written before any DA1 reply leaves the owner, whether the probe and DA1 arrive in one read or are
split across reads. The reply is
`ESC ] 7501 ; ? : states=idle,working,done,blocked,error : kinds=permission,question,auth ESC \`
(no spaces on the wire). It means the same as a bare `?`, but it can never be read as a probe, so an
echoed reply is never answered and a later probe is never taken for an echo. The authority lasts for
the whole session, so an agent started long after the shell is answered too. A torn probe not
completed within 500 ms is released raw and never answered.

### Composition on the read side, as presentation policy

Readers do not see a merged row. Each display reader composes the two slots with one pure function
that reads no clock and no timestamp:

- no slot: the hook entry, unchanged (same object);
- default, hooks first: the hook row wins unless it is absent, a seed Orca planted itself (at
  launch or from process output), or restored and not yet confirmed by a live event;
- with the new desktop setting `agentProgramStatusPreferred` on: the slot wins.

Because the choice reads no timestamp, the result never depends on which producer spoke last. A
7501-only agent that follows a hook agent in the same pane shows under hooks-first exactly when the
hook row's own lifecycle ends it (process exit, command end, interrupt, dismissal).

The entry built from a slot is display-only: the state, its start time and the main agent verdict
from the root record alone, with no agent type, tool or permission metadata; its required `prompt`
field is empty. The sidebar,
dot, worktree card, bucket counts, dashboard, pop-out and tabs read the composed map; the pop-out
receives cards the main window already composed. `worktree ps` composes on the host only for a
caller that asks (`composeProgramStatus`), which the new CLI does. Action readers (approve, auto
answer, stop, wait, hibernation, resume) and notification, unread, keep-awake and automation readers
keep reading hook rows only, so text a program prints can never trigger an action. With no visible
slot, composition returns the original hook map. Cache tokens retain their legacy form while
`programStatusEpoch` is zero; subsequent invalidations also track the program-status epoch.

### Lifecycle

- **Certified process exit:** the slot shows what remains on exit (`done` and `error` stay on an
  open pane, `working` goes). `exited` is final for that incarnation.
- **Unconfirmed loss** (a dropped daemon link): the view is kept and marked unverifiable; a reconnect
  applies a newer snapshot first, then goes live again.
- **Incarnation replaced:** a late fact of the old incarnation is dropped by its id.
- **Pane retired, tab closed, worktree removed:** the slot's own closure record refuses writes, while
  the ledger keeps tracking. When the renderer restores the pane, main resyncs the slot from the
  ledger, but only once its own pane and PTY maps name that pair on both sides; otherwise the
  request waits for the next spawn commit or leaf move.
- **Freshness:** a live slot never expires, since the protocol has no heartbeat. A slot that is no
  longer live decays on the reader's usual 30 minute window, measured from the last moment Orca
  could verify its producer.

### Dismissal is an operation bound to the PTY

Dismissing a card acknowledges exactly one incarnation, view and generation of the PTY's slot. Main
hides the slot only while the acknowledgement names what it shows, so a new state (a new generation)
shows again and a stale acknowledgement changes nothing. Across a process exit, the dismissal is
kept when the remaining view shows the same summary as the dismissed one. In the renderer, a
dismissal that can still be undone (the "Clear completed" toast) is its own operation, keyed by id.
It is bound to the PTY and the exact view it hid rather than to a pane record, so it follows the PTY
to another pane and survives a pane retire and restore. The dismiss button dismisses both
producers of the pane, each through its own operation, since "remove this row" with only the winner
dismissed would surface the other one.

## Compatibility

- **Daemon protocol 50.** Facts and the reply snapshot exist only at 50, behind a named capability
  check; 49 stays attachable. A protocol 49 or older session that survived an update has no tracker
  and stays hook-only until it ends. An app downgraded below 50 does not discover a protocol 50
  daemon, as with every protocol bump.
- **Spawn intent.** `programStatus` is an optional field of the startup ingress intent, sent only to
  daemons at 50 or later; an older parser drops it.
- **Stream.** A new `transientFact` kind inside the existing event, no new opcode; main ignores the
  kind from older daemons.
- **Optional fields only** on Electron IPC (an optional second argument on the drop and restore
  channels, optional fields on pop-out cards) and on `worktree.ps` (an optional parameter an old host
  strips). A caller that does not opt in gets the byte-exact legacy response.
- **Old clients and mobile see hooks only.** Mobile, `session.tabs.*` and paired clients receive
  exactly what they receive today; the composition epoch is renderer-local so a slot change never
  wakes the runtime sync that feeds mobile.
- **The setting is desktop-local.** It is not added to the client settings RPC, whose strict schema
  would make an old host reject a paired client's whole settings update.

## Scope

Supported: the macOS desktop app, for PTYs owned by main's local provider and by the persistent
daemon at protocol 50 or later.

Not yet: Linux (expected to require a small enabling change, updates to the scope tests, and
validation against a Linux capture), SSH panes (a pane with a `connectionId` is never armed, and
there is no SSH relay hop any more: support would need a remote-side tracker and reconnect snapshot
of the same shape), Windows ConPTY and WSL, `orca serve` hosts, daemons below protocol 50, and
agents inside tmux or another multiplexer. The listed unsupported platforms and providers
remain unarmed. Multiplexer passthrough is not supported or validated here; the outer macOS PTY
remains armed.

Display: state only. `msg`, `title` and `app` are validated but not displayed; applicable
validation failures can discard the report. Invalid `progress` values are treated as absent, and
`progress` is not displayed either. Subagents get no rows of their own.

## Rejected alternatives

- **A separate 7501 store and channel**, with readers merging two subscriptions. It breaks the
  one-store rule: every reader (sidebar, `worktree ps`, mobile, dashboard) would need a second
  source and its own merge, and the next producer would add a third.
- **Write-side arbitration in the shared hook row**, where the newest report from either producer
  overwrites one row. The result depends on arrival order, a 7501 report would inherit the hook
  row's agent identity and permission metadata, the hook row could not come back after a `clear` or
  a setting change, and one producer's teardown or dismissal would erase the other's state.
- **Answering the probe in the renderer** (an xterm.js OSC handler next to the existing capability
  replies). Hidden or parked panes may have no renderer receiving live bytes. While the daemon's
  shell-ready barrier holds, the daemon answers DA1 itself, so a renderer-only probe handler cannot
  guarantee the required reply order. One ordered authority at the owner is the only place that
  can guarantee the reply precedes DA1.
- **Answering in the headless terminal model** that main keeps for hidden panes. It answers only
  inside a forwarding window for chunks whose delivery to the renderer was dropped, and it hands its
  authority over when a remote viewer attaches. It also sits downstream of the owner, so it cannot
  put the reply before an owner-side DA1 answer either, and it would add a second answerer.

## Known limits

- If an agent leaves a `working` record without clearing it, and no shell prompt marker arrives,
  that record remains until the PTY process exits.
- Under hooks-first, a hook row that only goes silent (an agent that crashed without its PTY
  exiting) keeps winning over a live 7501 state until its own lifecycle ends it; the setting flips
  this.
- An agent that reports only through 7501 shows on the desktop sidebar, dashboard, pop-out, worktree
  card, tabs and opted-in `worktree ps`, but raises no notification or unread mark, does not keep
  the computer awake and is not shown on mobile.
- A retired pane refuses 7501 writes until the renderer restores it; the restore resyncs what the
  program reported meanwhile, once main's own pane and PTY maps name that pair. A pane that main
  moves itself (`src/main/runtime/orca-runtime.ts:213`, compiled only into an
  `ORCA_LAYOUT_OWNER=main` test build, which packaging refuses) sends no binding notification, so
  a restore waiting on it is not re-read and its slot can stay missing.
- Past 500 slot records, an evicted slot of a live PTY can remain absent until a subsequent
  published state change, lifecycle update, or pane resync; repeating an unchanged report does not
  necessarily restore it. The 500 bound is the hook cache's own.
- The slot is not persisted; a local PTY's state does not survive an app restart because the PTY
  itself does not.
- Slot times are on the PTY owner's clock and compared with main's clock. Both are the same host
  clock in the supported scope; a remote owner would need a translation.
- Reports are not authenticated: printing a file that contains a report changes that pane's
  displayed state. This is accepted because the result is display-only, attributed to its own pane
  and never read by an action.
