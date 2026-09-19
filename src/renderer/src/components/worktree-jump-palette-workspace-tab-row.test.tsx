// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandList } from '@/components/ui/command'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkspaceTabPaletteSearchResult } from '@/lib/workspace-tab-palette-results'
import { WorktreeJumpPaletteWorkspaceTabRow } from './worktree-jump-palette-workspace-tab-row'
import type { WorkspaceTabPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'

vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))

function makeResult(
  overrides: Partial<WorkspaceTabPaletteSearchResult> = {}
): WorkspaceTabPaletteSearchResult {
  return {
    paletteIdentity: 'workspace-tab::wt-1:tab-1',
    tabId: 'tab-1',
    entityId: 'term-1',
    worktreeId: 'wt-1',
    groupId: 'group-1',
    contentType: 'terminal',
    isPinned: false,
    occupantAgent: null,
    title: 'bash',
    secondaryText: '',
    secondaryMatches: [],
    repoName: 'repo',
    worktreeName: 'wt-1',
    branchName: 'main',
    titleRanges: [],
    secondaryRanges: [],
    repoRanges: [],
    worktreeRanges: [],
    branchRanges: [],
    typeAliasMatches: [],
    isCurrentTab: false,
    isCurrentWorktree: false,
    score: 0,
    qualityClass: null,
    rank: null,
    lastActiveAt: null,
    activity: { ageBucket: 0, timestamp: 0 },
    ...overrides
  }
}

function makeEntry(
  overrides: Partial<WorkspaceTabPaletteSearchResult> = {}
): WorkspaceTabPaletteItem {
  return { id: 'entry-1', type: 'workspace-tab', result: makeResult(overrides) }
}

function makeController(
  overrides: Partial<WorktreeJumpPaletteController> = {}
): WorktreeJumpPaletteController {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row only reads the fields stubbed below.
  return {
    resolveWorktree: () => undefined,
    repoMap: new Map(),
    repoByHostIdentity: new Map(),
    hostOptions: [],
    hostFilterActive: false,
    recentTabRowByItem: new Map(),
    paletteNowMs: 0,
    recentTabShortcutIndexByItem: new Map(),
    digitShortcutModifiers: [],
    handleSelectItem: vi.fn(),
    handleToggleWorkspaceTabPinned: vi.fn(),
    ...overrides
  } as unknown as WorktreeJumpPaletteController
}

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderRow(
  entryOverrides: Partial<WorkspaceTabPaletteSearchResult> = {},
  controllerOverrides: Partial<WorktreeJumpPaletteController> = {}
): {
  container: HTMLDivElement
  entry: WorkspaceTabPaletteItem
  controller: WorktreeJumpPaletteController
} {
  const entry = makeEntry(entryOverrides)
  const controller = makeController(controllerOverrides)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TooltipProvider>
        <Command>
          <CommandList>
            <WorktreeJumpPaletteWorkspaceTabRow
              entry={entry}
              renderKey="row-1"
              controller={controller}
            />
          </CommandList>
        </Command>
      </TooltipProvider>
    )
  })
  mounted.push({ container, root })
  return { container, entry, controller }
}

function getPinToggle(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('[data-palette-pin-toggle="true"]')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Missing pin toggle button')
  }
  return button
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('WorktreeJumpPaletteWorkspaceTabRow pin toggle', () => {
  it('renders a pin toggle reflecting the unpinned state', () => {
    const { container } = renderRow({ isPinned: false })

    const toggle = getPinToggle(container)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Pin tab')
  })

  it('renders a pin toggle reflecting the pinned state', () => {
    const { container } = renderRow({ isPinned: true })

    const toggle = getPinToggle(container)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Unpin tab')
  })

  it('toggles pin through the controller without opening the tab', () => {
    const { container, controller } = renderRow({ tabId: 'tab-42', isPinned: false })

    act(() => {
      getPinToggle(container).click()
    })

    expect(controller.handleToggleWorkspaceTabPinned).toHaveBeenCalledWith('tab-42', false)
    expect(controller.handleSelectItem).not.toHaveBeenCalled()
  })

  it('still opens the tab when the row itself is clicked outside the toggle', () => {
    const { container, entry, controller } = renderRow()

    act(() => {
      container
        .querySelector('[cmdk-item]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(controller.handleSelectItem).toHaveBeenCalledWith(entry)
  })
})
