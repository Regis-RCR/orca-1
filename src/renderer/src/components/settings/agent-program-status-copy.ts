import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getAgentProgramStatusTitle(): string {
  return translate(
    'settings.agents.agentProgramStatusPreferred.title',
    'Prefer status reported in the terminal'
  )
}

export function getAgentProgramStatusDescription(): string {
  return translate(
    'settings.agents.agentProgramStatusPreferred.description',
    'Some agents report their status in the terminal (OSC 7501). When on, that status is shown instead of the hook status. When off, hooks come first and the terminal status shows only where no hook reports.'
  )
}

export function getAgentProgramStatusSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.6984d4291a', fallback: 'status' },
    { key: 'auto.components.settings.agents.search.0d752916f8', fallback: 'hooks' },
    { key: 'settings.agents.agentProgramStatusPreferred.search.terminal', fallback: 'terminal' },
    { key: 'settings.agents.agentProgramStatusPreferred.search.prefer', fallback: 'prefer' },
    {
      key: 'settings.agents.agentProgramStatusPreferred.search.osc',
      fallback: 'osc',
      englishOnly: true
    },
    {
      key: 'settings.agents.agentProgramStatusPreferred.search.7501',
      fallback: '7501',
      englishOnly: true
    },
    {
      key: 'auto.components.settings.agents.search.f412abbba5',
      fallback: 'claude',
      englishOnly: true
    }
  ])
}
