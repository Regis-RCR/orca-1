import type { GlobalSettings } from '../global-settings-types'
import type { ProgramStatusPreference } from './compose-agent-status-entry'

/** Desktop settings as persisted: the store does not validate them, so every value is unknown. */
export type ProgramStatusPreferenceSettings = Partial<Record<keyof GlobalSettings, unknown>>

/** `agentProgramStatusPreferred`, read by key and strictly: persisted settings are not validated. */
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
