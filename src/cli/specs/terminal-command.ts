import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_COMMAND_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'command'],
  summary: 'Send one slash command to a Claude Code terminal, guarded, with a receipt',
  usage:
    'orca terminal command [--terminal <handle>] --command <name> [--args <text> | --args-file <path>] [--wait-receipt <seconds>] [--require-draft] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'terminal',
    'command',
    'args',
    'args-file',
    'wait-receipt',
    'require-draft'
  ],
  notes: [
    'Refuses before writing a byte when a permission prompt or an AskUserQuestion modal is open, when the composer holds text, or when the composer cannot be read.',
    'Writes /<name>, then " <args>", then Enter as separate raw writes; never a bracketed paste.',
    '--wait-receipt observes the session transcript for up to N seconds (maximum 3600) and never resends.',
    'Exit 0 once the Enter is written, whatever receipt.stage says; a stage below executed is unproven, not failed. Exit 1 on a refusal or a withheld Enter.'
  ],
  examples: [
    'orca terminal command --terminal term_abc123 --command compact --json',
    'orca terminal command --terminal term_abc123 --command goal --args-file ./goal.md --wait-receipt 30 --json'
  ]
}
