import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  isProgramStatusPreferred,
  programStatusPreferenceOf
} from '../../../../shared/program-status/program-status-preference'
import { buildCapabilitySettingsSections } from '@/hooks/settings-navigation-capability-sections'
import {
  getAgentProgramStatusDescription,
  getAgentProgramStatusTitle
} from './agent-program-status-copy'
import { AgentProgramStatusSetting } from './AgentProgramStatusSetting'
import { AgentsPane, getAgentsPaneSearchEntries } from './AgentsPane'
import { LOCAL_SETTINGS_HOST_SCOPE } from './settings-host-scope'
import { matchesSettingsSearch } from './settings-search'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: [],
    isLoading: false,
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

type ElementLike = { props: Record<string, unknown> }

function isElementLike(value: unknown): value is ElementLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'props' in value &&
    typeof value.props === 'object' &&
    value.props !== null
  )
}

function toggle(row: ElementLike): void {
  const onChange = row.props.onChange
  if (typeof onChange === 'function') {
    onChange()
  }
}

function findSwitch(node: unknown): ElementLike {
  const stack = [node]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry == null || typeof entry !== 'object') {
      continue
    }
    if (Array.isArray(entry)) {
      stack.push(...entry)
      continue
    }
    if (!isElementLike(entry)) {
      continue
    }
    const element = entry
    if (
      typeof element.props?.checked === 'boolean' &&
      typeof element.props.onChange === 'function'
    ) {
      return element
    }
    stack.push(element.props?.children)
  }
  throw new Error('switch row not found')
}

function renderSetting(settings: GlobalSettings, updateSettings = vi.fn()) {
  // Why call it: the switch row sits under SearchableSetting, so walk the element tree.
  return findSwitch(AgentProgramStatusSetting({ settings, updateSettings }))
}

function renderPane(settings: GlobalSettings): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(AgentsPane, {
        settings,
        updateSettings: vi.fn(),
        hostScope: LOCAL_SETTINGS_HOST_SCOPE
      })
    )
  )
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__ORCA_WEB_CLIENT__')
})

describe('the OSC 7501 precedence setting', () => {
  it('defaults to hooks first', () => {
    const settings = getDefaultSettings('/tmp')
    expect(settings.agentProgramStatusPreferred).toBe(false)
    expect(programStatusPreferenceOf(settings)).toBe('hooks-first')
    expect(renderSetting(settings).props.checked).toBe(false)
  })

  it('switches to the next value on each toggle', () => {
    const updateSettings = vi.fn()
    const off = renderSetting(getDefaultSettings('/tmp'), updateSettings)
    toggle(off)
    expect(updateSettings).toHaveBeenLastCalledWith({ agentProgramStatusPreferred: true })
    const on = renderSetting(
      { ...getDefaultSettings('/tmp'), agentProgramStatusPreferred: true },
      updateSettings
    )
    expect(on.props.checked).toBe(true)
    toggle(on)
    expect(updateSettings).toHaveBeenLastCalledWith({ agentProgramStatusPreferred: false })
  })

  it('reads the typed setting as the composition preference, and nothing else as preferred', () => {
    const on = { ...getDefaultSettings('/tmp'), agentProgramStatusPreferred: true }
    expect(isProgramStatusPreferred(on)).toBe(true)
    expect(programStatusPreferenceOf(on)).toBe('program-status-first')
    expect(isProgramStatusPreferred({ agentProgramStatusPreferred: 'true' })).toBe(false)
    expect(isProgramStatusPreferred(null)).toBe(false)
  })

  it('renders the switch in the desktop Agents pane with its copy', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))
    expect(markup).toContain(getAgentProgramStatusTitle())
    expect(markup).toContain(getAgentProgramStatusDescription())
  })

  it('keeps the desktop-local switch out of paired web clients and their search', () => {
    Reflect.set(globalThis, '__ORCA_WEB_CLIENT__', true)
    expect(renderPane(getDefaultSettings('/tmp'))).not.toContain(getAgentProgramStatusTitle())
    expect(
      matchesSettingsSearch(
        'osc 7501',
        getAgentsPaneSearchEntries({ includeAgentProgramStatus: false })
      )
    ).toBe(false)
  })

  it('is found by settings search on the desktop', () => {
    const entries = getAgentsPaneSearchEntries()
    expect(matchesSettingsSearch('osc 7501', entries)).toBe(true)
    expect(matchesSettingsSearch('prefer status', entries)).toBe(true)
  })

  it('wires the desktop-only search entry through the settings navigation', () => {
    const agents = (isWebClient: boolean) =>
      buildCapabilitySettingsSections({
        isMac: true,
        isWindows: false,
        isLocalWindowsHost: false,
        isWindowsTerminalHost: false,
        isWebClient,
        nativeChatEnabled: false,
        managedBrowserCreationEnabled: false,
        mobileEmulatorCreationEnabled: false,
        isDev: false,
        isLinearConnected: false,
        hostQueuesMessages: false,
        repos: []
      }).find((section) => section.id === 'agents')!
    expect(matchesSettingsSearch('osc 7501', agents(false).searchEntries)).toBe(true)
    expect(matchesSettingsSearch('osc 7501', agents(true).searchEntries)).toBe(false)
  })
})
