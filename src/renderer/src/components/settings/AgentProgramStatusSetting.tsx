import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isProgramStatusPreferred } from '../../../../shared/program-status/program-status-preference'
import {
  getAgentProgramStatusDescription,
  getAgentProgramStatusSearchKeywords,
  getAgentProgramStatusTitle
} from './agent-program-status-copy'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type AgentProgramStatusSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** Which producer wins when a pane has both a hook row and an OSC 7501 report. */
export function AgentProgramStatusSetting({
  settings,
  updateSettings
}: AgentProgramStatusSettingProps): React.JSX.Element {
  const title = getAgentProgramStatusTitle()
  const description = getAgentProgramStatusDescription()
  const preferred = isProgramStatusPreferred(settings)
  return (
    <section className="space-y-3">
      <SearchableSetting
        title={title}
        description={description}
        keywords={getAgentProgramStatusSearchKeywords()}
      >
        <SettingsSwitchRow
          label={title}
          description={description}
          checked={preferred}
          onChange={() => void updateSettings({ agentProgramStatusPreferred: !preferred })}
        />
      </SearchableSetting>
    </section>
  )
}
