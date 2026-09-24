import { readFile } from 'node:fs/promises'
import { TERMINAL_COMMAND_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  normalizeTerminalCommandName,
  validateTerminalCommandArgs,
  type RuntimeTerminalCommand
} from '../../shared/terminal-command-contract'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { getTerminalHandle } from '../selectors'

type TerminalCommandResult = { command: RuntimeTerminalCommand }

const RPC_TIMEOUT_MARGIN_MS = 30_000

async function readArgs(flags: Map<string, string | boolean>): Promise<string | undefined> {
  const inline = getOptionalStringFlag(flags, 'args')
  const file = getOptionalStringFlag(flags, 'args-file')
  if (inline !== undefined && file !== undefined) {
    throw new RuntimeClientError('invalid_argument', 'Pass --args or --args-file, not both.')
  }
  // Why: `--text " $(cat file)"` strips the final newline; the file is read byte for byte.
  const args = file !== undefined ? await readFile(file, 'utf8') : inline
  if (args !== undefined && !validateTerminalCommandArgs(args)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Args may not contain CR or ESC: either byte can submit or reframe the input halfway through.'
    )
  }
  return args
}

/** The caller's own handle, only when it still names a live identity. */
async function liveCallerHandle(client: RuntimeClient): Promise<string | undefined> {
  const handle = process.env.ORCA_TERMINAL_HANDLE
  if (!handle) {
    return undefined
  }
  try {
    const response = await client.call<{ identity?: { live?: boolean } }>(
      'terminal.resolveIdentity',
      { terminal: handle }
    )
    return response.result.identity?.live === true ? handle : undefined
  } catch {
    return undefined
  }
}

function formatTerminalCommand(command: RuntimeTerminalCommand): string {
  if (command.refusal) {
    const staged = command.stagedText
      ? ' Text is staged in the composer; the Enter was withheld.'
      : ''
    return `refused ${command.refusal.code}: ${command.refusal.message} (${command.bytesWritten} bytes written).${staged}`
  }
  const stage = command.receipt?.stage ?? 'input_accepted'
  return `sent /${command.name} to ${command.handle}: ${stage} (draft ${command.draftCheck ?? 'n/a'}, self ${String(command.selfTarget)})`
}

export const terminalCommandHandler: CommandHandler = async ({ flags, client, cwd, json }) => {
  const rawName = getRequiredStringFlag(flags, 'command')
  const name = normalizeTerminalCommandName(rawName)
  if (name === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--command must match [A-Za-z0-9][A-Za-z0-9:_-]*, with or without a leading /.'
    )
  }
  const args = await readArgs(flags)
  const waitReceiptSeconds = getOptionalPositiveIntegerFlag(flags, 'wait-receipt')
  if (waitReceiptSeconds && waitReceiptSeconds > 3600) {
    throw new RuntimeClientError('invalid_argument', '--wait-receipt must be at most 3600 seconds.')
  }
  const waitReceiptMs = waitReceiptSeconds ? waitReceiptSeconds * 1000 : 0
  const status = await client.getCliStatus()
  if (
    !status.result.runtime.reachable ||
    status.result.runtime.capabilities?.includes(TERMINAL_COMMAND_RUNTIME_CAPABILITY) !== true
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not support terminal command. No input was sent; update Orca on the execution host. The verb never falls back to unguarded writes.'
    )
  }
  const terminal = await getTerminalHandle(flags, cwd, client)
  const callerTerminal = await liveCallerHandle(client)
  const params = {
    terminal,
    command: name,
    ...(args ? { args } : {}),
    ...(waitReceiptMs ? { waitReceiptMs } : {}),
    ...(flags.get('require-draft') === true ? { requireDraft: true as const } : {}),
    ...(callerTerminal ? { callerTerminal } : {})
  }
  const response = await client.call<TerminalCommandResult>('terminal.command', params, {
    timeoutMs: waitReceiptMs + RPC_TIMEOUT_MARGIN_MS
  })
  const command = response.result.command
  if (command.refusal) {
    process.exitCode = 1
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: { code: command.refusal.code, message: command.refusal.message },
            result: { command }
          },
          null,
          2
        )
      )
    } else {
      console.log(formatTerminalCommand(command))
    }
    return
  }
  // Why: exit 0 whatever the receipt stage. A stage below executed is unproven, not failed, and
  // the command may still run at the next turn boundary, so the caller must not resend (#22472).
  if (json) {
    console.log(JSON.stringify({ ok: true, result: { command } }, null, 2))
  } else {
    console.log(formatTerminalCommand(command))
  }
}
