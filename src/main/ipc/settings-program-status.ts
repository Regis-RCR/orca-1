import type { GlobalSettings } from '../../shared/global-settings-types'

/** A renderer write keeps `agentProgramStatusPreferred` only as a strict boolean. Outside
 *  settings.ts, which sits at its line budget. */
export function withStrictProgramStatusPreference(
  update: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  return 'agentProgramStatusPreferred' in update
    ? { ...update, agentProgramStatusPreferred: update.agentProgramStatusPreferred === true }
    : update
}
