import { resolve } from 'node:path'
import { describe, it } from 'vitest'
import { createBridgeHost } from '../../mobile-web-shell/bridge-host'
import {
  createBridgeRpcClient,
  type BridgeRpcClient
} from '../../mobile-web-shell/bridge/bridge-rpc-client'
import { familyGoldens, pilotGoldens } from './derived-goldens'
import { compareGolden, readGolden } from './golden-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import type { Recording, RecordingScenario } from './recording-scenario'
import { readScenarios } from './scenario-input'
import type { ScriptedClientWrapper } from './scripted-rpc-transport'
import { runRecording } from './run-recording'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'

/**
 * Every golden, recorded again with the page bridge between the operation and the scripted
 * transport, and compared body for body against the committed file.
 *
 * The claim it is built to certify is the one C1 needs before a screen moves to the web: a screen
 * driven through `BridgeRpcClient` observes what it observes on the native client, down to the
 * byte. Headers are excluded because they are provenance of the committed recording, not of this
 * run. This suite writes nothing, and it is not in `RECORDING_DRIVERS`, so `recorderSha256` does
 * not pin it — a suite that cannot put an observation in a recorded file is not provenance for one.
 *
 * ## Why it is off by default
 *
 * It does not pass yet, and the causes are findings about the bridge rather than about the corpus.
 * Measured on 2026-09-18 over all 787 goldens against the tree this lands on: 763 diverge, 24
 * replay byte-identically. Four causes, none of them a reason to re-record anything.
 *
 * 1. **372 goldens: `BridgeReplyPayloadSchema` requires `_meta` on both arms.** The native client's
 *    own acceptance predicate for a reply off the wire, `transport/rpc-response-shape.ts`, requires
 *    none, and `src/shared/runtime-rpc-envelope.ts` — the envelope clients and runtimes share —
 *    makes `_meta` optional on a failure and its `runtimeId` nullable. The page's reader is
 *    strictly narrower than the transport it stands in for, so replies the phone accepts today are
 *    refused. Widening the two arms to an optional `_meta`, and to a nullable `runtimeId` on the
 *    failure arm, takes the divergence from 763 to 391 and is the whole of that class.
 * 2. **340 goldens: the `result-absent` reply partition.** `{ ok: true }` with no `result` key is
 *    refused by the page's reader and by `isRpcResponse` alike, so this one is not a bridge defect:
 *    the recorder injects that partition at the scripted sender port, below the frame validation
 *    both sides do, which is what the README means by not claiming malformed-frame coverage. A
 *    reply shape the wire itself drops cannot cross a real frame boundary, so byte-identical
 *    replay is not available for it at any bridge, and this class is a bound on the claim rather
 *    than a bug to close.
 * 3. **13 goldens: a `subscribe` publishes after a `sendRequest` that natively preceded it.**
 *    `BridgeRpcClient.subscribe` returns synchronously while the shell's `client.subscribe` runs a
 *    microtask later, and the request's logical ordinal is taken at the call. This is exactly the
 *    reorder `write-ordinal.ts` exists to catch, and it is a real property of the bridge: 7 sender
 *    ordinals and 6 payload ordinals.
 * 4. **13 goldens: an own property whose value is `undefined` does not survive JSON.** The wire
 *    frame is serialized either way, so the desktop sees the same bytes; what changes is that
 *    `projectMobileRpcRequestParams` runs shell-side on params that have already lost the key.
 *
 * Amplifying all of them: a `reply` frame the page's reader refuses is dropped with a diagnostic
 * and nothing settles the request, so one narrow schema becomes a cascade of stranded promises.
 *
 * Flipping the gate is one line once those close, and the counts above are the ratchet.
 */

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

/** One document's turn at the bridge is the whole recording, so both are constants. */
const SESSION_ID = 'recording-session'
const BUILD_ID = 'recording-build'
/** `ready` out, `init` back: two deliveries, and a round to see that the session landed. */
const HANDSHAKE_ROUNDS = 4

type BridgeLane = {
  push: (json: string) => void
  /** Delivers what is queued now, for the one exchange that has to land before anything mounts. */
  drainNow: () => void
}

/**
 * One direction of the pair: a FIFO queue drained one frame per microtask.
 *
 * Both properties are load-bearing for a byte-identical replay. FIFO, because a `subscribe` that
 * overtook a `sendRequest` moves the shared write ordinal, which is the reorder `write-ordinal.ts`
 * exists to catch. A microtask, because it is the weakest async the runner's zero-time drains flush
 * and the only one that moves no virtual millisecond off the recording's pinned clock.
 */
function bridgeLane(deliver: (json: string) => void): BridgeLane {
  const queue: string[] = []
  let scheduled = false
  function drainOne(): void {
    scheduled = false
    const next = queue.shift()
    if (next === undefined) {
      return
    }
    deliver(next)
    schedule()
  }
  function schedule(): void {
    if (scheduled || queue.length === 0) {
      return
    }
    scheduled = true
    void Promise.resolve().then(drainOne)
  }
  return {
    push(json: string): void {
      queue.push(json)
      schedule()
    },
    drainNow(): void {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        deliver(next)
      }
    }
  }
}

/**
 * The handshake, synchronously, before the operation mounts.
 *
 * `BridgeRpcClient` refuses every member until `init` has landed, and its getters are what a screen
 * reads during its first render. A mount that raced the handshake would record a different first
 * render, so the one exchange the page cannot start without is the one exchange delivered in place.
 * Nothing else has been queued at this point, so draining here cannot reorder anything.
 */
function primeSession(toShell: BridgeLane, toPage: BridgeLane, page: BridgeRpcClient): void {
  for (let round = 0; round < HANDSHAKE_ROUNDS; round += 1) {
    toShell.drainNow()
    toPage.drainNow()
    if (page.getShellSession() !== null) {
      return
    }
  }
  throw new Error('the page never received `init` from the bridge host')
}

/** The page's client over an in-memory pair to a host holding the recorder's scripted client. */
function throughBridge(): ScriptedClientWrapper {
  return (client) => {
    let receiveOnPage: ((json: string) => void) | null = null
    const toPage = bridgeLane((json) => receiveOnPage?.(json))
    const host = createBridgeHost({
      client,
      post: (json) => {
        toPage.push(json)
        return Promise.resolve()
      },
      buildId: BUILD_ID,
      sessionId: SESSION_ID
    })
    const toShell = bridgeLane((json) => {
      host.receive(json)
    })
    const page = createBridgeRpcClient({
      send: (json) => {
        toShell.push(json)
      },
      onMessage: (handler) => {
        receiveOnPage = handler
        return () => {
          receiveOnPage = null
        }
      }
    })
    primeSession(toShell, toPage, page)
    return page
  }
}

async function recordThroughBridge(scenario: RecordingScenario): Promise<Recording> {
  const { adapters } = pilotMountAdapters(root, { device: scenario })
  return await runRecording(
    scenario,
    adapters[scenario.operation],
    vitestRecordingScheduler(),
    throughBridge()
  )
}

/**
 * Body against body. The committed header is spliced onto the bridged recording so `compareGolden`
 * reports the scenario, checkpoint, field and JSON path it always does, and so the provenance of
 * the committed file is not compared against a run that did not produce it.
 */
function expectSameBody(id: string, recording: Recording): void {
  const expected = readGolden(directory, id)
  compareGolden(expected, { ...expected, recording })
}

describe.runIf(process.env.RPC_FOUNDATION_BRIDGE === '1')(
  'every golden replays byte-identically through the page bridge',
  () => {
    for (const pilot of pilotGoldens(input.scenarios)) {
      it(`${pilot.id}: bridged parity`, async () => {
        expectSameBody(pilot.id, await recordThroughBridge(pilot.scenario))
      })
    }
    for (const golden of familyGoldens(input.scenarios)) {
      it(
        `${golden.id}: bridged parity`,
        async () => {
          const checkpoints: Recording['checkpoints'] = []
          for (const scenario of golden.scenarios()) {
            const recording = await recordThroughBridge(scenario)
            for (const checkpoint of recording.checkpoints) {
              checkpoints.push({ ...checkpoint, id: `${scenario.id}:${checkpoint.id}` })
            }
          }
          expectSameBody(golden.id, { scenario: golden.id, checkpoints })
        },
        golden.timeoutMs
      )
    }
  }
)
