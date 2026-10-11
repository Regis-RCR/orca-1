import type { ClaudeAccountSwitchSettings } from './claude-account-switch-settings'
import type { NativeChatGlobalSettings } from './native-chat-appearance-settings'
import type { WorktreeDeletionPreferences } from './worktree-deletion-preferences'

type ProgramStatusGlobalSettings = {
  /** OSC 7501 program status wins over hook status in display readers. Desktop-local presentation
   *  policy: never sent to the hook server, the daemon or a paired client. */
  agentProgramStatusPreferred: boolean
}

/** Settings groups owned by their feature modules and composed into GlobalSettings. */
export type GlobalSettingsBase = NativeChatGlobalSettings &
  WorktreeDeletionPreferences &
  ClaudeAccountSwitchSettings &
  ProgramStatusGlobalSettings
