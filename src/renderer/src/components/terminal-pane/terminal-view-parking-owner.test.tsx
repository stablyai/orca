/** @vitest-environment happy-dom */
import { act, StrictMode, Suspense, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { TerminalRuntimeOwners } from '../../app-shell/TerminalRuntimeOwners'
import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { capturedPanesByTabId } from './terminal-parked-watcher-registry'

const harness = vi.hoisted(() => ({
  events: new Array<string>(),
  watched: new Set<string>(),
  batches: 0,
  inspections: 0
}))
vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => {
    harness.inspections += 1
    return true
  },
  terminalWatcherLiveWorkspaceIds: (ids: Iterable<string>) => new Set(ids),
  pruneParkedTerminalWatchers: () => {},
  disposeAllParkedTerminalWatchers: () => {
    harness.watched.clear()
  },
  syncParkedTerminalTabWatchersForWorkspaces: (
    entries: ReadonlyMap<
      string,
      { tabs: readonly TerminalTab[]; parkedTabIds: ReadonlySet<string> }
    >
  ) => {
    if (!entries.size) {
      return
    }
    harness.batches += 1
    for (const entry of entries.values()) {
      for (const tab of entry.tabs) {
        if (entry.parkedTabIds.has(tab.id)) {
          if (!harness.watched.has(tab.id)) {
            harness.events.push(`start:${tab.id}`)
          }
          harness.watched.add(tab.id)
        } else {
          if (harness.watched.has(tab.id)) {
            harness.events.push(`stop:${tab.id}`)
          }
          harness.watched.delete(tab.id)
        }
      }
    }
  }
}))
vi.mock('./parked-terminal-tab-capture-episodes', () => ({
  captureNewlyParkedTerminalTabs: () => {}
}))
vi.mock('./terminal-cold-park-withheld-tabs', () => ({
  withholdUnparkableTerminalTabs: (args: { coldParkedTabIds: ReadonlySet<string> }) => ({
    parkedTabIds: args.coldParkedTabIds,
    parkVerdictPinUntilMsByTabId: new Map()
  })
}))
vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({
    coldParkDelayMs: 30_000,
    hotRetainMs: 300_000,
    hotRetainLimit: 0
  })
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('./TerminalOverlaySlot', () => ({
  TerminalOverlaySlot: ({ terminalTabId }: { terminalTabId: string }) => (
    <Pane tabId={terminalTabId} />
  )
}))
vi.mock('../native-chat/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: () => {}
}))
const initial = useAppStore.getInitialState()
const id = 'repo::/root-parking'
function tab(tabId = 'tab'): TerminalTab {
  return {
    id: tabId,
    worktreeId: id,
    ptyId: `${id}@@${tabId}`,
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function Pane({ tabId }: { tabId: string }): null {
  useEffect(() => {
    harness.events.push(`pane:${tabId}`)
    return () => {
      harness.events.push(`capture:${tabId}`)
    }
  }, [tabId])
  return null
}
function Host({
  visible = false,
  park = false,
  worktreeId = id
}: {
  visible?: boolean
  park?: boolean
  worktreeId?: string
}): React.JSX.Element {
  return (
    <TerminalPaneOverlayLayer
      worktreeId={worktreeId}
      worktreePath="/root-parking"
      isWorktreeActive={visible}
      coldParkTerminalPanes={park}
    />
  )
}
function AbortedHost(): React.JSX.Element {
  Host({ park: true })
  throw new Promise(() => {})
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({ ...initial, tabsByWorktree: { [id]: [tab()] } }, true)
  harness.events = []
  harness.watched.clear()
  harness.batches = 0
  harness.inspections = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(initial, true)
  capturedPanesByTabId.clear()
  vi.useRealTimers()
})
function render(host: React.ReactNode): void {
  act(() =>
    root.render(
      <>
        <TerminalRuntimeOwners />
        {host}
      </>
    )
  )
}
describe('root terminal ownership', () => {
  it('captures before watcher start, survives host departure, and releases before revealed IPC', () => {
    render(<Host visible />)
    harness.events = []
    render(<Host park />)
    expect(harness.events).toEqual(['capture:tab', 'start:tab'])
    render(null)
    expect(harness.watched).toEqual(new Set(['tab']))
    render(<Host park />)
    expect(harness.events.filter((e) => e === 'start:tab')).toHaveLength(1)
    render(<Host visible />)
    expect(harness.watched.size).toBe(0)
    expect(harness.events.filter((e) => e === 'stop:tab')).toHaveLength(1)
    act(() => useAppStore.setState({ tabsByWorktree: {} }))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reconciles detached split PTY and layout replacement without tab chrome', () => {
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    const layout = (secondPty: string, activeLeafId = first): TerminalLayoutSnapshot => ({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: first },
        second: { type: 'leaf', leafId: second }
      },
      activeLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [first]: 'pty-first', [second]: secondPty }
    })
    useAppStore.setState({
      ptyIdsByTabId: { tab: ['pty-first', 'pty-old'] },
      terminalLayoutsByTabId: { tab: layout('pty-old') }
    })
    render(<Host park />)
    render(null)
    harness.batches = 0
    act(() =>
      useAppStore.setState({
        ptyIdsByTabId: { tab: ['pty-first', 'pty-new'] },
        terminalLayoutsByTabId: { tab: layout('pty-new') }
      })
    )
    expect(harness.batches).toBe(1)
    act(() => useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 1: 'working' } } }))
    const afterTitleKey = harness.batches
    act(() => useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 1: 'idle' } } }))
    expect(harness.batches).toBe(afterTitleKey)
    act(() => useAppStore.setState({ terminalLayoutsByTabId: { tab: layout('pty-new', second) } }))
    expect(harness.batches).toBe(afterTitleKey + 1)
  })
  it('unions two committed hosts and ignores an abandoned render', () => {
    render(
      <>
        <Host key="main" visible />
        <Host key="floating" park />
      </>
    )
    expect(harness.watched.size).toBe(0)
    render(
      <>
        <Host key="main" visible />
        <Suspense fallback={null}>
          <AbortedHost />
        </Suspense>
      </>
    )
    expect(harness.watched.size).toBe(0)
    render(<Host key="main" park />)
    expect(harness.watched).toEqual(new Set(['tab']))
  })
  it('reinstalls the sole authority through StrictMode and covers a floating-only host', () => {
    act(() =>
      root.render(
        <StrictMode>
          <TerminalRuntimeOwners />
          <Host park />
        </StrictMode>
      )
    )
    expect(harness.watched).toEqual(new Set(['tab']))
    render(null)
    expect(harness.watched).toEqual(new Set(['tab']))
  })
  it('owns the synthetic floating workspace before the main controller mounts', () => {
    useAppStore.setState({
      tabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [{ ...tab(), worktreeId: FLOATING_TERMINAL_WORKTREE_ID }]
      }
    })
    render(<Host worktreeId={FLOATING_TERMINAL_WORKTREE_ID} park />)
    expect(harness.watched).toEqual(new Set(['tab']))
    render(null)
    expect(harness.watched).toEqual(new Set(['tab']))
    render(<Host worktreeId={FLOATING_TERMINAL_WORKTREE_ID} visible />)
    expect(harness.watched.size).toBe(0)
  })
  it('starts a tab clock on first presentation, preserving it through detach and reattach', () => {
    useAppStore.setState({ tabsByWorktree: { [id]: [tab(), tab('a')] } })
    render(null)
    act(() => vi.advanceTimersByTime(600_000))
    render(<Host />)
    expect(harness.watched.size).toBe(0)
    act(() => vi.advanceTimersByTime(20_000))
    render(null)
    render(<Host />)
    act(() => vi.advanceTimersByTime(10_000))
    expect(harness.watched).toEqual(new Set(['tab']))
  })
  it.each([10, 100])(
    'does no tab inspections or registry sweeps on unrelated writes across %i workspaces',
    (count) => {
      const tabsByWorktree: Record<string, TerminalTab[]> = {}
      for (let n = 0; n < count; n += 1) {
        tabsByWorktree[`workspace-${n}`] = [{ ...tab(`tab-${n}`), worktreeId: `workspace-${n}` }]
      }
      useAppStore.setState({ tabsByWorktree })
      render(null)
      expect(harness.watched.size).toBe(count)
      harness.inspections = 0
      harness.batches = 0
      act(() => useAppStore.setState({ sortEpoch: 1 }))
      expect(harness.inspections).toBe(0)
      expect(harness.batches).toBe(0)
      act(() =>
        useAppStore.setState({
          tabsByWorktree: {
            ...tabsByWorktree,
            'workspace-0': [{ ...tabsByWorktree['workspace-0'][0], title: 'new title' }]
          }
        })
      )
      expect(harness.inspections).toBeLessThanOrEqual(1)
      expect(harness.batches).toBeLessThanOrEqual(1)
    }
  )
})
