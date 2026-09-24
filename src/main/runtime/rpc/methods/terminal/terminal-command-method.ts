import {
  parseClaudeCommandReceipt,
  readClaudeTranscriptSince,
  statClaudeTranscriptSize
} from '../../../../claude/claude-transcript-command-receipt'
import {
  normalizeTerminalCommandName,
  validateTerminalCommandArgs,
  type RuntimeTerminalCommand
} from '../../../../../shared/terminal-command-contract'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  runTerminalCommandSequence,
  type TerminalCommandGuardReading,
  type TerminalCommandSequenceDeps
} from '../../../terminal-command-sequence'
import type { TerminalCommandTarget } from '../../../terminal-command-target'
import { defineMethod } from '../../core'
import { assertTerminalAgentSendable } from '../../terminal-agent-send-guard'
import { assertTerminalSendExactPtyBinding } from './terminal-input-delivery'
import { TerminalCommand } from './unary-schemas'

function refusal(
  handle: string,
  name: string,
  code: 'invalid_argument',
  message: string
): { command: RuntimeTerminalCommand } {
  return {
    command: {
      handle,
      name,
      argsBytes: 0,
      selfTarget: 'unknown',
      writes: [],
      bytesWritten: 0,
      refusal: { code, message }
    }
  }
}

async function readGuards(
  runtime: OrcaRuntimeService,
  handle: string,
  target: TerminalCommandTarget
): Promise<TerminalCommandGuardReading> {
  if (target.agent !== null && target.agent !== 'claude') {
    return {
      ok: false,
      code: 'unsupported_agent',
      message: `The foreground agent is ${target.agent}, not Claude Code; no input was sent.`
    }
  }
  try {
    // The existing sendable guard: refuses on a permission prompt, fails closed without an agent.
    await assertTerminalAgentSendable({
      runtime,
      handle,
      assertWritable: () => assertTerminalSendExactPtyBinding(runtime, handle, target.ptyId)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'terminal_guard_permission') {
      return {
        ok: false,
        code: 'agent_awaiting_permission',
        message: 'A permission prompt is open.'
      }
    }
    if (message === 'terminal_guard_no_agent') {
      return {
        ok: false,
        code: 'agent_status_unknown',
        message: 'No running agent was proven in time.'
      }
    }
    throw error
  }
  // Why: an AskUserQuestion modal may surface as a wait rather than as `permission` (open question 3).
  const wait = await runtime.getTerminalInteractiveWait(handle)
  if (wait === undefined) {
    return {
      ok: false,
      code: 'agent_status_unknown',
      message: 'The interactive-wait state could not be read in time.'
    }
  }
  if (wait !== null) {
    return {
      ok: false,
      code: 'agent_awaiting_answer',
      message: `The session is waiting for an answer (${wait.source}).`
    }
  }
  const status = await runtime.getTerminalAgentStatus(handle)
  return { ok: true, agentStatus: status.status, interactiveWait: null }
}

export const TERMINAL_COMMAND_METHODS = [
  defineMethod({
    name: 'terminal.command',
    params: TerminalCommand,
    handler: async (params, { runtime, signal }) => {
      const name = normalizeTerminalCommandName(params.command)
      if (name === null) {
        return refusal(params.terminal, params.command, 'invalid_argument', 'Invalid command name.')
      }
      if (params.args !== undefined && !validateTerminalCommandArgs(params.args)) {
        return refusal(params.terminal, name, 'invalid_argument', 'Args may not contain CR or ESC.')
      }
      const target = runtime.getTerminalCommandTarget(params.terminal, params.callerTerminal)
      const source = target.receiptSource
      let offset: number | null = null
      const deps: TerminalCommandSequenceDeps = {
        checkGuards: () => readGuards(runtime, params.terminal, target),
        readComposer: async () => runtime.readTerminalCommandComposer(target.ptyId),
        write: async (data) => {
          const action = data === '\r' ? { enter: true } : { text: data }
          const result = await runtime.sendTerminal(params.terminal, action, {
            signal,
            beforeWrite: (ptyId) =>
              assertTerminalSendExactPtyBinding(runtime, params.terminal, ptyId)
          })
          return result.accepted === true
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        ...(source
          ? {
              receipt: {
                start: async () => {
                  offset = await statClaudeTranscriptSize(source.transcriptPath)
                  return offset !== null
                },
                poll: async () => {
                  if (offset === null) {
                    return null
                  }
                  const read = await readClaudeTranscriptSince(source.transcriptPath, offset)
                  if (read === null) {
                    return null
                  }
                  // Each poll reads only new bytes; the sequence keeps the best stage across polls.
                  offset += read.consumed
                  return parseClaudeCommandReceipt(read.lines, name, source.sessionIds)
                }
              }
            }
          : {})
      }
      const command = await runTerminalCommandSequence(
        {
          handle: params.terminal,
          name,
          ...(params.args ? { args: params.args } : {}),
          requireDraft: params.requireDraft === true,
          waitReceiptMs: params.waitReceiptMs ?? 0,
          selfTarget: target.selfTarget
        },
        deps
      )
      return { command }
    }
  })
]
