import type { GlobalSettings } from '../global-settings-types'
import type { ProgramStatusPreference } from './compose-agent-status-entry'

/** Desktop settings as persisted: the store does not validate them, so every value is unknown. */
export type ProgramStatusPreferenceSettings = Partial<Record<keyof GlobalSettings, unknown>>

/** The desktop setting that prefers OSC 7501 over hooks, read by key until its switch ships. */
export function isProgramStatusPreferred(
  settings: ProgramStatusPreferenceSettings | null | undefined
): boolean {
  return (
    !!settings &&
    'agentProgramStatusPreferred' in settings &&
    settings.agentProgramStatusPreferred === true
  )
}

export function programStatusPreferenceOf(
  settings: ProgramStatusPreferenceSettings | null | undefined
): ProgramStatusPreference {
  return isProgramStatusPreferred(settings) ? 'program-status-first' : 'hooks-first'
}
