import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { getTerminalLinkActionSearchKeywords } from './browser-search'
import {
  terminalLinkClickBehaviorFor,
  type TerminalLinkClickBehavior
} from '../terminal-pane/terminal-link-click-behavior'

type BrowserTerminalLinkActionsSettingProps = {
  settings: Pick<
    GlobalSettings,
    | 'terminalLinkActionPopoverEnabled'
    | 'terminalLinkClickBehavior'
    | 'terminalUrlMiddleClickBehavior'
  >
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserTerminalLinkActionsSetting({
  settings,
  isMac,
  updateSettings
}: BrowserTerminalLinkActionsSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.title',
    'Link click behavior'
  )
  const description = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.description.v2',
    'Choose what a plain click does. Cmd/Ctrl-click always opens directly, and Shift keeps its alternate destination.'
  )
  const behavior = terminalLinkClickBehaviorFor(settings)

  return (
    <SearchableSetting
      id={BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={getTerminalLinkActionSearchKeywords({ isMac })}
    >
      <div className="ml-4 border-l border-border pl-4">
        <SettingsRow
          label={title}
          description={description}
          alignTop
          control={
            <SettingsSegmentedControl<TerminalLinkClickBehavior>
              value={behavior}
              onChange={(value) => updateSettings({ terminalLinkClickBehavior: value })}
              ariaLabel={title}
              size="sm"
              options={[
                { value: 'actions', label: 'Show actions' },
                { value: 'open', label: 'Open directly' },
                { value: 'none', label: 'Modifier-click only' }
              ]}
            />
          }
        />
        <SettingsRow
          label="Middle-click URLs"
          description="Choose what mouse-wheel clicks do on terminal URLs."
          control={
            <SettingsSegmentedControl<TerminalLinkClickBehavior>
              value={settings.terminalUrlMiddleClickBehavior ?? 'open'}
              onChange={(value) => updateSettings({ terminalUrlMiddleClickBehavior: value })}
              ariaLabel="Middle-click URLs"
              size="sm"
              options={[
                { value: 'open', label: 'Open' },
                { value: 'actions', label: 'Actions' },
                { value: 'none', label: 'Leave alone' }
              ]}
            />
          }
        />
      </div>
    </SearchableSetting>
  )
}
