// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { hydratePersistedUIAfterStartupRead } from '@/lib/startup-ui-hydration'
import { registerSettingsAndSidebarIpcBridge } from '@/hooks/ipc-events/settings-sidebar-ipc-bridge'
import { createWebUiApi } from '@/web/preload-api/web-ui-api'
import { writeStoredRuntimeEnvironment } from '@/web/web-preload-api-test-harness'
import { FEATURE_INTERACTION_IDS } from '../../../../shared/feature-interactions'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { makePersistedUI } from '@/store/slices/ui-slice-test-harness'
import wslMoveAgentModelUI from '../../../../shared/__fixtures__/wsl-move-agent-model-ui.json'
import WorktreeCardAgents from './WorktreeCardAgents'
import {
  WorktreeCardDisplayMenuItem,
  WorktreeCardPropertiesMenuItem
} from './worktree-card-option-items'
import { clearWorktreeAgentExpansionStateForTests } from './worktree-card-agents-expansion-state'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))
vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

const NOW = 2000
const LEAF = '11111111-1111-4111-8111-111111111111'
function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'folder-1',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}
function entry(id: string): AgentStatusEntry {
  return {
    paneKey: `${id}:${LEAF}`,
    state: 'working',
    agentType: 'claude',
    prompt: 'Review',
    updatedAt: NOW,
    stateStartedAt: 1000,
    stateHistory: [],
    model: '  reported-model  '
  }
}

function sourceRows() {
  const parent = entry('hook')
  parent.subagents = [
    {
      id: 'child',
      state: 'working',
      startedAt: 1500,
      model: 'child-model',
      description: 'Child review'
    }
  ]
  return buildWorktreeAgentRows({
    tabs: [tab('hook'), tab('title')],
    entries: [parent, { ...entry('orphan'), worktreeId: 'folder-1', tabId: 'orphan' }],
    retained: [
      {
        entry: entry('retained'),
        tab: tab('retained'),
        worktreeId: 'folder-1',
        agentType: 'claude',
        startedAt: 1000
      }
    ],
    ptyIdsByTabId: { hook: ['hook-pty'], title: ['title-pty'] },
    runtimePaneTitlesByTabId: { title: { 1: '✳ Claude Code' } },
    terminalLayoutsByTabId: {
      title: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    },
    now: NOW
  })
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

// Keep portal/disclosure mechanics out of this fixture; production menus, store and rows stay mounted.
vi.mock('@/components/ui/dropdown-menu', () => {
  const content = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      disabled,
      onCheckedChange
    }: {
      children?: ReactNode
      checked?: boolean
      disabled?: boolean
      onCheckedChange?: (checked: boolean) => void
    }) => (
      <button
        disabled={disabled}
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {children}
      </button>
    ),
    DropdownMenuLabel: content,
    DropdownMenuRadioGroup: content,
    DropdownMenuRadioItem: content,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: content,
    DropdownMenuSubContent: content,
    DropdownMenuSubTrigger: content
  }
})
const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/web/preload-api/web-runtime-calls', () => ({ callRuntimeResult: transport.call }))
vi.mock('@/hooks/use-now', () => ({ useNow: () => NOW }))

const originalState = useAppStore.getState()
let root: Root
let container: HTMLDivElement
let stateChanged: ((ui: PersistedUIState) => void) | undefined
let unsubs: (() => void)[]
const setUI = vi.fn().mockResolvedValue(undefined)

function controls(): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>('button[role="menuitemcheckbox"]')
  ].filter((button) => button.textContent === 'Agent model')
}

function mount(): void {
  const rows = sourceRows()
  expect(rows).toHaveLength(5)
  expect(rows.find((row) => row.tab.id === 'title')?.entry.model).toBeUndefined()
  expect(
    rows
      .filter((row) => row.entry.model)
      .map((row) => row.rowSource)
      .sort()
  ).toEqual(['live', 'live', 'retained', 'subagent'])
  act(() =>
    root.render(
      <TooltipProvider>
        <WorktreeCardPropertiesMenuItem preserveWorkspaceBoardOpen={false} />
        <WorktreeCardDisplayMenuItem preserveWorkspaceBoardOpen={false} />
        <WorktreeCardAgents worktreeId="folder-1" agents={rows} />
      </TooltipProvider>
    )
  )
  expect(controls()).toHaveLength(2)
}

function expectVisibleModels(visible: boolean): void {
  for (const mode of ['compact', 'full'] as const) {
    act(() => useAppStore.setState({ agentActivityDisplayMode: mode }))
    if (mode === 'compact') {
      const expand = container.querySelector<HTMLButtonElement>('button[aria-label^="Expand "]')
      if (expand) {
        act(() => expand.click())
      }
      expect(container.querySelector('.compact-agent-summary-panel-expanded')).not.toBeNull()
    }
    const tree = container.querySelector('[role="tree"]')
    expect(tree).not.toBeNull()
    expect(tree?.querySelectorAll('span.font-mono[title]')).toHaveLength(visible ? 4 : 0)
    expect(tree?.querySelectorAll('[title="reported-model"]')).toHaveLength(visible ? 3 : 0)
    expect(
      tree?.querySelectorAll('.worktree-agent-lineage-children [title="child-model"]')
    ).toHaveLength(visible ? 1 : 0)
    for (const control of controls()) {
      expect(control.getAttribute('aria-checked')).toBe(String(visible))
    }
  }
}

beforeEach(() => {
  useAppStore.setState({ ...originalState, persistedUIReady: false, showAgentModels: true }, true)
  window.localStorage.clear()
  transport.call.mockReset()
  setUI.mockClear()
  unsubs = []
  stateChanged = undefined
  clearWorktreeAgentExpansionStateForTests()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        ...createWebUiApi(),
        set: setUI,
        onStateChanged: (callback: (ui: PersistedUIState) => void) => {
          stateChanged = callback
          return () => {
            stateChanged = undefined
          }
        }
      },
      settings: { onChanged: () => () => {} }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  unsubs.forEach((unsub) => unsub())
  container.remove()
  useAppStore.setState(originalState, true)
  window.localStorage.clear()
  clearWorktreeAgentExpansionStateForTests()
})

describe('agent model visibility across persisted UI consumers', () => {
  it.each([undefined, false])(
    'hydrates a delayed profile (%s), toggles both menus and consumes live snapshots',
    async (saved) => {
      let finishRead: (ui: PersistedUIState) => void = () => {
        throw new Error('Read not started')
      }
      const read = new Promise<PersistedUIState>((resolve) => {
        finishRead = resolve
      })
      window.api.ui.get = () => read
      registerSettingsAndSidebarIpcBridge(unsubs)
      mount()
      for (const control of controls()) {
        expect(control.disabled).toBe(true)
        act(() => control.click())
      }
      expect(setUI).not.toHaveBeenCalled()
      expect(useAppStore.getState().persistedUIReady).toBe(false)
      const loaded = window.api.ui.get().then((persistedUI) =>
        hydratePersistedUIAfterStartupRead({
          persistedUI,
          cancelled: false,
          hydratePersistedUI: useAppStore.getState().hydratePersistedUI
        })
      )
      await act(async () => {
        const persisted = makePersistedUI({ showAgentModels: saved })
        if (saved === undefined) {
          delete persisted.showAgentModels
        }
        finishRead(persisted)
        await loaded
      })
      for (const control of controls()) {
        expect(control.disabled).toBe(false)
      }
      expectVisibleModels(saved !== false)
      for (const index of [0, 1]) {
        act(() => controls()[index].click())
        expect(setUI).toHaveBeenLastCalledWith({ showAgentModels: saved === false })
        expectVisibleModels(saved === false)
        act(() => controls()[index].click())
        expectVisibleModels(saved !== false)
      }
      // Exercise the registered production desktop broadcast callback, in both directions.
      expect(stateChanged).toBeTypeOf('function')
      act(() => stateChanged?.(makePersistedUI({ showAgentModels: false })))
      expectVisibleModels(false)
      act(() => stateChanged?.(makePersistedUI({})))
      expectVisibleModels(true)
    }
  )

  it('consumes browser get and feature results without letting host snapshots choose local visibility', async () => {
    writeStoredRuntimeEnvironment(window.localStorage)
    const ui = createWebUiApi()
    mount()
    for (const local of [undefined, false]) {
      for (const host of [true, undefined]) {
        const hostUI = makePersistedUI({ showAgentModels: host, sidebarWidth: 365 })
        if (host === undefined) {
          delete hostUI.showAgentModels
        }
        transport.call.mockResolvedValue({ ui: hostUI })
        for (const read of [
          () => ui.get(),
          () => ui.recordFeatureInteraction(FEATURE_INTERACTION_IDS[0])
        ]) {
          window.localStorage.setItem('orca.web.ui.v1', JSON.stringify({ showAgentModels: local }))
          const snapshot = await read()
          expect(snapshot.sidebarWidth).toBe(365)
          act(() => useAppStore.getState().hydratePersistedUI(snapshot))
          expectVisibleModels(local !== false)
          expect(
            JSON.parse(window.localStorage.getItem('orca.web.ui.v1') ?? '{}').showAgentModels
          ).toBe(local !== false)
        }
      }
    }
    expect(transport.call).toHaveBeenCalledWith('ui.get', undefined, 15_000)
    expect(transport.call).toHaveBeenCalledWith(
      'ui.recordFeatureInteraction',
      FEATURE_INTERACTION_IDS[0],
      15_000
    )
  })

  it('preserves hidden desktop models after scoped WSL projection and routing rewrite', () => {
    mount()
    act(() =>
      useAppStore
        .getState()
        .hydratePersistedUI(makePersistedUI(wslMoveAgentModelUI.desktopAfterMove))
    )
    expectVisibleModels(false)
  })
})
