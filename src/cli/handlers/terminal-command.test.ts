import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { TERMINAL_COMMAND_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { TERMINAL_HANDLERS } from './terminal'

const ORIGINAL_EXIT_CODE = process.exitCode
const ORIGINAL_HANDLE = process.env.ORCA_TERMINAL_HANDLE

function sent(overrides: Record<string, unknown> = {}) {
  return {
    handle: 'term-1',
    name: 'compact',
    argsBytes: 0,
    selfTarget: false,
    writes: [
      { kind: 'command', bytes: 8 },
      { kind: 'submit', bytes: 1 }
    ],
    bytesWritten: 9,
    draftCheck: 'match',
    receipt: { stage: 'input_accepted', source: 'transcript' },
    ...overrides
  }
}

function client(options: { capable?: boolean; command?: Record<string, unknown>; live?: boolean }) {
  const call = vi.fn(async (method: string) => {
    if (method === 'terminal.resolveIdentity') {
      return { ok: true, result: { identity: { live: options.live ?? true } } }
    }
    return { ok: true, result: { command: options.command ?? sent() }, _meta: { runtimeId: 'r' } }
  })
  const getCliStatus = vi.fn().mockResolvedValue({
    result: {
      runtime: {
        reachable: true,
        runtimeId: 'r',
        capabilities: options.capable === false ? [] : [TERMINAL_COMMAND_RUNTIME_CAPABILITY]
      }
    }
  })
  return { call, client: { call, getCliStatus } as unknown as RuntimeClient }
}

async function run(flags: [string, string | true][], c: RuntimeClient) {
  return TERMINAL_HANDLERS['terminal command']({
    flags: new Map<string, string | true>([['terminal', 'term-1'], ...flags]),
    client: c,
    cwd: '/tmp/worktree',
    json: true
  })
}

function commandCalls(call: ReturnType<typeof vi.fn>) {
  return call.mock.calls.filter(([method]) => method === 'terminal.command')
}

describe('terminal command CLI', () => {
  let dir: string

  beforeEach(async () => {
    process.exitCode = undefined
    delete process.env.ORCA_TERMINAL_HANDLE
    dir = await mkdtemp(join(tmpdir(), 'orca-terminal-command-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
    if (ORIGINAL_HANDLE === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = ORIGINAL_HANDLE
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('sends the normalized name, args, receipt wait and draft requirement', async () => {
    const { call, client: c } = client({})
    await run(
      [
        ['command', '/goal'],
        ['args', 'ship it'],
        ['wait-receipt', '5'],
        ['require-draft', true]
      ],
      c
    )
    expect(commandCalls(call)).toEqual([
      [
        'terminal.command',
        {
          terminal: 'term-1',
          command: 'goal',
          args: 'ship it',
          waitReceiptMs: 5_000,
          requireDraft: true
        },
        { timeoutMs: 35_000 }
      ]
    ])
    expect(process.exitCode).toBeUndefined()
  })

  it('passes the caller handle only when it is proven live', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term-self'
    const live = client({ live: true })
    await run([['command', 'rename']], live.client)
    expect(commandCalls(live.call)[0]?.[1]).toMatchObject({ callerTerminal: 'term-self' })

    const stale = client({ live: false })
    await run([['command', 'rename']], stale.client)
    expect(commandCalls(stale.call)[0]?.[1]).not.toHaveProperty('callerTerminal')
  })

  it('reads --args-file byte for byte, final newline included', async () => {
    const path = join(dir, 'body.md')
    await writeFile(path, 'first paragraph\n\nsecond paragraph\n')
    const { call, client: c } = client({})
    await run(
      [
        ['command', 'goal'],
        ['args-file', path]
      ],
      c
    )
    expect(commandCalls(call)[0]?.[1]).toMatchObject({
      args: 'first paragraph\n\nsecond paragraph\n'
    })
  })

  it.each([
    ['a bad name', [['command', 'bad name']]],
    ['a double slash', [['command', '//compact']]],
    [
      'CR in args',
      [
        ['command', 'goal'],
        ['args', 'early\rsubmit']
      ]
    ],
    [
      'ESC in args',
      [
        ['command', 'goal'],
        ['args', 'x\u001b[200~']
      ]
    ],
    [
      'both args flags',
      [
        ['command', 'goal'],
        ['args', 'a'],
        ['args-file', '/dev/null']
      ]
    ],
    [
      'a wait above 3600 s',
      [
        ['command', 'compact'],
        ['wait-receipt', '3601']
      ]
    ]
  ] as [string, [string, string][]][])('refuses %s with no RPC call', async (_label, flags) => {
    const { call, client: c } = client({})
    await expect(run(flags, c)).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(commandCalls(call)).toEqual([])
  })

  it('refuses an older host with incompatible_runtime and writes nothing', async () => {
    const { call, client: c } = client({ capable: false })
    await expect(run([['command', 'compact']], c)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(commandCalls(call)).toEqual([])
  })

  it('exits 1 with the runtime refusal code in the JSON error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { client: c } = client({
      command: sent({
        writes: [],
        bytesWritten: 0,
        refusal: { code: 'agent_awaiting_permission', message: 'A permission prompt is open.' }
      })
    })
    await run([['command', 'compact']], c)
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'agent_awaiting_permission' },
      result: { command: { bytesWritten: 0 } }
    })
  })

  it('exits 0 whatever the receipt stage once the Enter is written', async () => {
    const { client: c } = client({
      command: sent({ receipt: { stage: 'unverifiable', source: 'none' } })
    })
    await run([['command', 'compact']], c)
    expect(process.exitCode).toBeUndefined()
  })
})

describe('terminal send --guarded', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it('sets requireAgentStatus sendable on each phase', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({
      ok: true,
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 8 } }
    })
    const c = { call } as unknown as RuntimeClient
    for (const phase of [
      ['text', '/compact'],
      ['enter', true]
    ] as [string, string | true][]) {
      await TERMINAL_HANDLERS['terminal send']({
        flags: new Map<string, string | true>([['terminal', 'term-1'], phase, ['guarded', true]]),
        client: c,
        cwd: '/tmp/worktree',
        json: true
      })
    }
    expect(call.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ text: '/compact', requireAgentStatus: 'sendable' }),
      expect.objectContaining({ enter: true, requireAgentStatus: 'sendable' })
    ])
    expect(call.mock.calls.every(([, params]) => !('agentPrompt' in params))).toBe(true)
  })

  it('refuses text and Enter in one guarded call, with no RPC call', async () => {
    const call = vi.fn()
    await expect(
      TERMINAL_HANDLERS['terminal send']({
        flags: new Map<string, string | true>([
          ['terminal', 'term-1'],
          ['text', '/compact'],
          ['enter', true],
          ['guarded', true]
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('leaves an unguarded send byte for byte as before', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({
      ok: true,
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 1 } }
    })
    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })
    expect(call).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: undefined,
      enter: true,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })
})
