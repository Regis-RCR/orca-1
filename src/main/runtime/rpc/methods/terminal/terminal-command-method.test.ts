import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TerminalComposerState } from '../../../../../shared/terminal-composer-draft'
import type { RuntimeTerminalAgentStatusState } from '../../../../../shared/runtime-terminal-contracts'
import { eraseRpcMethods } from '../../core'
import { TERMINAL_COMMAND_METHODS } from './terminal-command-method'

type FakeOptions = {
  agent?: string | null
  status?: RuntimeTerminalAgentStatusState
  wait?: { source: string } | null | undefined
  composer?: TerminalComposerState[]
}

function fakeRuntime(options: FakeOptions) {
  const composer = [...(options.composer ?? [{ state: 'empty' as const }])]
  const sendTerminal = vi.fn(
    async (_handle: string, action: { text?: string; enter?: boolean }) => {
      return { handle: 'term', accepted: true, bytesWritten: action.text?.length ?? 1 }
    }
  )
  const runtime = {
    getTerminalCommandTarget: () => ({
      ptyId: 'pty-1',
      agent: options.agent === undefined ? 'claude' : options.agent,
      selfTarget: false,
      receiptSource: null
    }),
    readTerminalCommandComposer: () =>
      composer.length > 1 ? composer.shift()! : (composer[0] ?? { state: 'unobservable' }),
    resolveLiveLeafForHandle: () => ({ ptyId: 'pty-1' }),
    getTerminalAgentStatus: async () => ({
      handle: 'term',
      isRunningAgent: true,
      status: options.status ?? 'idle'
    }),
    getTerminalInteractiveWait: async () => ('wait' in options ? options.wait : null),
    sendTerminal
  }
  return { runtime: runtime as unknown as OrcaRuntimeService, sendTerminal }
}

async function invoke(params: Record<string, unknown>, runtime: OrcaRuntimeService) {
  const method = eraseRpcMethods(TERMINAL_COMMAND_METHODS)[0]!
  if (!method.params || 'stream' in method) {
    throw new Error('terminal.command must be unary')
  }
  return (await method.handler(method.params.parse(params), { runtime })) as {
    command: { refusal?: { code: string }; bytesWritten: number; draftCheck?: string }
  }
}

describe('terminal.command RPC method', () => {
  it('writes /name then a bare Enter through raw sends, never an agent prompt', async () => {
    const { runtime, sendTerminal } = fakeRuntime({
      composer: [{ state: 'empty' }, { state: 'text', text: '/compact' }]
    })
    const { command } = await invoke({ terminal: 'term', command: 'compact' }, runtime)
    expect(command.refusal).toBeUndefined()
    expect(sendTerminal.mock.calls.map(([, action]) => action)).toEqual([
      { text: '/compact' },
      { enter: true }
    ])
    expect(command.draftCheck).toBe('match')
  })

  it('maps an open permission prompt to agent_awaiting_permission with zero writes', async () => {
    const { runtime, sendTerminal } = fakeRuntime({ status: 'permission' })
    const { command } = await invoke({ terminal: 'term', command: 'compact' }, runtime)
    expect(command.refusal?.code).toBe('agent_awaiting_permission')
    expect(command.bytesWritten).toBe(0)
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('maps an interactive wait to agent_awaiting_answer with zero writes', async () => {
    const { runtime, sendTerminal } = fakeRuntime({ wait: { source: 'hook' } })
    const { command } = await invoke({ terminal: 'term', command: 'compact' }, runtime)
    expect(command.refusal?.code).toBe('agent_awaiting_answer')
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('fails closed with agent_status_unknown when the wait cannot be read', async () => {
    const { runtime, sendTerminal } = fakeRuntime({ wait: undefined })
    const { command } = await invoke({ terminal: 'term', command: 'compact' }, runtime)
    expect(command.refusal?.code).toBe('agent_status_unknown')
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('refuses a non-Claude agent with unsupported_agent', async () => {
    const { runtime, sendTerminal } = fakeRuntime({ agent: 'codex' })
    const { command } = await invoke({ terminal: 'term', command: 'compact' }, runtime)
    expect(command.refusal?.code).toBe('unsupported_agent')
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('refuses a non-empty composer with composer_not_empty', async () => {
    const { runtime, sendTerminal } = fakeRuntime({
      composer: [{ state: 'text', text: 'staged' }]
    })
    const { command } = await invoke({ terminal: 'term', command: 'compact' }, runtime)
    expect(command.refusal?.code).toBe('composer_not_empty')
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('revalidates the name and args on the host', async () => {
    const { runtime, sendTerminal } = fakeRuntime({})
    expect(
      (await invoke({ terminal: 'term', command: 'a b' }, runtime)).command.refusal?.code
    ).toBe('invalid_argument')
    expect(
      (await invoke({ terminal: 'term', command: 'goal', args: 'x\ry' }, runtime)).command.refusal
        ?.code
    ).toBe('invalid_argument')
    expect(sendTerminal).not.toHaveBeenCalled()
  })
})
