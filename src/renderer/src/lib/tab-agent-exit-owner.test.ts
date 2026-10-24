import { getDefaultSettings } from '../../../shared/constants'
import { ALL_TUI_AGENTS } from '../../../shared/tui-agent-display-names'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import type { AgentStatusEntry } from '@/store/slices/agent-status'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Tab } from '../../../shared/tab-types'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { makeTab, makeUnifiedTab, makeWorktree } from '@/store/slices/store-test-helpers'
import type { AppState } from '@/store/types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getTabAgentExitOwner } from './tab-agent-exit-owner'

const leaf = '11111111-1111-4111-8111-111111111111'
const pane = makePaneKey('tab', leaf)
const tab: TerminalTab = makeTab({
  id: 'tab',
  worktreeId: 'workspace',
  ptyId: 'pty-a',
  title: 'zsh',
  launchAgent: 'codex',
  createdAt: 0
})
const row = (state: AgentStatusEntry['state']): AgentStatusEntry => ({
  paneKey: pane,
  agentType: 'codex',
  state,
  prompt: 'task',
  stateHistory: [],
  stateStartedAt: 10,
  updatedAt: 20
})
function setup(titles?: readonly string[], patch?: Partial<AppState>) {
  const store = createStore(createAppState)
  const status = getAgentStatusOwner(store)
  const items: Tab[] = (titles ?? []).map((label, n) =>
    makeUnifiedTab({
      id: `item-${n}`,
      entityId: tab.id,
      worktreeId: tab.worktreeId,
      groupId: `g${n}`,
      label,
      sortOrder: n,
      createdAt: 0
    })
  )
  store.setState({
    tabsByWorktree: { workspace: [tab] },
    ptyIdsByTabId: { tab: ['pty-a'] },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'pty-a' }
      }
    },
    unifiedTabsByWorktree: { workspace: items },
    layoutByWorktree: titles
      ? {
          workspace: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', groupId: 'g0' },
            second: { type: 'leaf', groupId: 'g1' }
          }
        }
      : {},
    ...patch
  })
  const service = getTabAgentExitOwner(status)
  const stop = service.start()
  stops.push(stop)
  return { store, status, service, stop }
}
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop()
  }
  vi.restoreAllMocks()
})

describe('root terminal exit evidence on captured canonical pairs', () => {
  it.each([
    ['codex', 'zsh'],
    ['zsh', 'codex']
  ])('keeps duplicate saved group histories independent: %s/%s', (...titles) => {
    const { store, service } = setup(titles)
    const clear = vi.fn(store.getState().clearTabLaunchAgent)
    store.setState({ clearTabLaunchAgent: clear })
    expect(clear).not.toHaveBeenCalled()
    expect(service.getObservation('workspace', 'tab', 'g0')).toBe(titles[0] === 'codex')
    expect(service.getObservation('workspace', 'tab', 'g1')).toBe(titles[1] === 'codex')
    store.getState().updateTabTitle('tab', 'codex running')
    expect(clear).not.toHaveBeenCalled()
    const current = store.getState()
    const signalled = titles.indexOf('codex')
    store.setState({
      unifiedTabsByWorktree: {
        workspace: current.unifiedTabsByWorktree.workspace.map((item, index) =>
          index === signalled ? { ...item, label: 'zsh' } : item
        )
      }
    })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(store.getState().tabsByWorktree.workspace[0].launchAgent).toBeUndefined()
  })

  it('retains a completion followed by recursive row removal, without a mounted hook', () => {
    const { store, status, service } = setup()
    const clear = vi.fn(store.getState().clearTabLaunchAgent)
    store.setState({ clearTabLaunchAgent: clear })
    let removed = false
    store.subscribe(() => {
      if (status.getEntry(pane)?.state === 'done' && !removed) {
        removed = true
        status.transact((transaction) => transaction.setEntry(pane, undefined))
        expect(status.getEntry(pane)).toBeUndefined()
        expect(clear).not.toHaveBeenCalled()
      }
    })
    status.transact((transaction) => {
      transaction.setEntry(pane, row('done'))
      store.setState({ agentStatusEpoch: store.getState().agentStatusEpoch + 1 })
    })
    expect(removed).toBe(true)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(service.getObservation('workspace', 'tab')).toBe(true)
  })

  it.each(['working', 'replacement'] as const)(
    'cannot clear a newer %s runtime during recursive delivery',
    (kind) => {
      const { store, status } = setup()
      const clear = vi.fn(store.getState().clearTabLaunchAgent)
      store.setState({ clearTabLaunchAgent: clear })
      let changed = false
      store.subscribe(() => {
        if (status.getEntry(pane)?.state === 'done' && !changed) {
          changed = true
          if (kind === 'working') {
            status.transact((transaction) => transaction.setEntry(pane, row('working')))
          } else {
            store.setState({ tabsByWorktree: { workspace: [{ ...tab, title: 'codex new' }] } })
          }
        }
      })
      status.transact((transaction) => {
        transaction.setEntry(pane, row('done'))
        store.setState({ agentStatusEpoch: 1 })
      })
      expect(changed).toBe(true)
      expect(clear).not.toHaveBeenCalled()
      expect(store.getState().tabsByWorktree.workspace[0].launchAgent).toBe('codex')
    }
  )
  it.each(['local', 'wsl', 'ssh', 'paired-old', 'paired-current'] as const)(
    'keeps transport loss distinct from local exit: %s',
    (kind) => {
      const pty =
        kind === 'paired-old'
          ? toRemoteRuntimePtyId('old')
          : kind === 'paired-current'
            ? toRemoteRuntimePtyId('new', 'host')
            : 'pty-a'
      const { store, status, service } = setup(undefined, {
        repos: [
          {
            id: 'repo',
            path: '/workspace',
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 0,
            ...(kind === 'ssh' ? { connectionId: 'ssh-host' } : {})
          }
        ],
        worktreesByRepo: {
          repo: [
            makeWorktree({
              id: 'workspace',
              repoId: 'repo',
              path: kind === 'wsl' ? '\\\\wsl.localhost\\Ubuntu\\work' : '/workspace'
            })
          ]
        },
        ptyIdsByTabId: { tab: [pty] },
        terminalLayoutsByTabId: {
          tab: {
            root: { type: 'leaf', leafId: leaf },
            activeLeafId: leaf,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leaf]: pty }
          }
        }
      })
      const clear = vi.fn(store.getState().clearTabLaunchAgent)
      store.setState({ clearTabLaunchAgent: clear })
      status.transact((transaction) => transaction.setEntry(pane, row('working')))
      expect(service.getObservation('workspace', 'tab')).toBe(true)
      status.transact((transaction) => transaction.setEntry(pane, undefined))
      const local = kind === 'local' || kind === 'wsl'
      expect(clear).toHaveBeenCalledTimes(local ? 1 : 0)
      if (!local) {
        status.transact((transaction) => transaction.setEntry(pane, row('done')))
        expect(clear).toHaveBeenCalledTimes(1)
      }
    }
  )

  it('seeds after registration, forgets departed scopes, and releases its root subscription', () => {
    const { store, service, status, stop } = setup(['codex', 'zsh'])
    const cleared = vi.fn(store.getState().clearTabLaunchAgent)
    store.setState({ clearTabLaunchAgent: cleared })
    stop()
    status.transact((transaction) => transaction.setEntry(pane, row('done')))
    expect(cleared).not.toHaveBeenCalled()
    expect(service.getObservation('workspace', 'tab', 'g0')).toBe(false)
    const restart = service.start()
    stops.push(restart)
    // One current seed; no replay of the pre-registration accepted completion.
    expect(cleared).toHaveBeenCalledTimes(1)
    expect(service.getObservation('workspace', 'tab', 'g1')).toBe(true)
    status.transact((transaction) => transaction.setEntry(pane, undefined))
    store.setState({ layoutByWorktree: { workspace: { type: 'leaf', groupId: 'g1' } } })
    expect(service.getObservation('workspace', 'tab', 'g0')).toBe(false)
    store.setState({ tabsByWorktree: { workspace: [] } })
    expect(service.getObservation('workspace', 'tab', 'g1')).toBe(false)
    store.setState({
      tabsByWorktree: { workspace: [makeTab({ ...tab, title: 'codex' })] },
      unifiedTabsByWorktree: {}
    })
    expect(service.getObservation('workspace', 'tab')).toBe(true)
    const changed = vi.fn()
    const off = service.subscribe('tab', changed)
    restart()
    expect(changed).toHaveBeenCalledTimes(1)
    store.getState().updateTabTitle('tab', 'zsh')
    expect(changed).toHaveBeenCalledTimes(1)
    off()
  })

  it('uses the last saved item in a group, including compound renames and later group changes', () => {
    const { store, service } = setup(['codex', 'zsh'])
    const initial = store.getState().unifiedTabsByWorktree.workspace
    store.setState({
      unifiedTabsByWorktree: { workspace: [{ ...initial[0], groupId: 'g1' }, initial[1]] }
    })
    expect(service.getObservation('workspace', 'tab', 'g1')).toBe(false)
    const clear = vi.fn(store.getState().clearTabLaunchAgent)
    store.setState({ clearTabLaunchAgent: clear })
    store.setState({
      unifiedTabsByWorktree: { workspace: [initial[1], { ...initial[0], groupId: 'g1' }] }
    })
    expect(service.getObservation('workspace', 'tab', 'g1')).toBe(true)
    store.getState().setTabCustomTitle('tab', 'zsh')
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it.each(['raw', 'bulk', 'nested', 'overwritten-hint'] as const)(
    'discovers complete %s producer fallback',
    (kind) => {
      const { store, status, service } = setup()
      const second = makeTab({
        id: 'other',
        worktreeId: 'workspace',
        title: 'zsh',
        ptyId: 'other-pty',
        launchAgent: 'codex'
      })
      store.setState({ tabsByWorktree: { workspace: [tab, second] } })
      const rename = (id: string, title: string) => {
        store.setState((state) => ({
          tabsByWorktree: {
            workspace: state.tabsByWorktree.workspace.map((item) =>
              item.id === id ? { ...item, title } : item
            )
          }
        }))
      }
      if (kind === 'raw') {
        rename('other', 'codex')
      }
      if (kind === 'bulk') {
        store.getState().updateTabTitles([
          { tabId: 'tab', title: 'codex' },
          { tabId: 'other', title: 'codex' }
        ])
      }
      if (kind === 'nested') {
        let nested = false
        const off = store.subscribe(() => {
          if (!nested) {
            nested = true
            rename('other', 'codex')
          }
        })
        store.getState().updateTabTitle('tab', 'codex')
        off()
      }
      if (kind === 'overwritten-hint') {
        status.transact(() => {
          store.getState().updateTabTitle('tab', 'codex')
          rename('other', 'codex')
        })
      }
      expect(service.getObservation('workspace', 'other')).toBe(true)
      const clear = vi.fn(store.getState().clearTabLaunchAgent)
      store.setState({ clearTabLaunchAgent: clear })
      rename('other', 'zsh')
      expect(clear).toHaveBeenCalledWith('other')
    }
  )
})

it.each(ALL_TUI_AGENTS)(
  'keeps %s working and sibling blockers, then accepts retained completion',
  (agent) => {
    const { store, status } = setup(undefined, {
      tabsByWorktree: { workspace: [{ ...tab, launchAgent: agent }] }
    })
    const sibling = makePaneKey('tab', '22222222-2222-4222-8222-222222222222')
    const clear = vi.fn(store.getState().clearTabLaunchAgent)
    store.setState({
      clearTabLaunchAgent: clear,
      terminalLayoutsByTabId: {
        tab: {
          root: null,
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-a', '22222222-2222-4222-8222-222222222222': 'pty-b' }
        }
      }
    })
    status.transact((transaction) => {
      transaction.setEntry(pane, { ...row('working'), agentType: agent })
      transaction.setEntry(sibling, { ...row('working'), paneKey: sibling, agentType: agent })
    })
    expect(clear).not.toHaveBeenCalled()
    status.transact((transaction) =>
      transaction.setEntry(pane, { ...row('done'), agentType: agent })
    )
    expect(clear).not.toHaveBeenCalled()
    status.transact((transaction) => transaction.setEntry(pane, undefined))
    expect(clear).not.toHaveBeenCalled()
    status.transact((transaction) => {
      transaction.setEntry(sibling, undefined)
      store.setState({
        retainedAgentsByPaneKey: {
          [pane]: {
            entry: { ...row('done'), agentType: agent },
            worktreeId: 'workspace',
            agentType: agent,
            tab,
            startedAt: 20
          }
        }
      })
    })
    expect(clear).toHaveBeenCalledExactlyOnceWith('tab')
  }
)

it('uses real hook and generated-title publications without clearing a working launch', () => {
  const { store, status } = setup()
  const clear = vi.fn(store.getState().clearTabLaunchAgent)
  const generated = vi.fn(store.getState().setGeneratedTabTitlesFromAgentPrompts)
  store.setState({
    clearTabLaunchAgent: clear,
    setGeneratedTabTitlesFromAgentPrompts: generated,
    settings: {
      ...(store.getState().settings ?? getDefaultSettings('/tmp')),
      tabAutoGenerateTitle: true
    }
  })
  store
    .getState()
    .setAgentStatus(pane, { agentType: 'codex', state: 'working', prompt: 'Explain this function' })
  expect(status.getEntry(pane)?.state).toBe('working')
  expect(generated).toHaveBeenCalledTimes(1)
  expect(store.getState().tabsByWorktree.workspace[0].generatedTitle).toBe('Explain this function')
  expect(clear).not.toHaveBeenCalled()
  store.getState().setTabCustomTitle('tab', 'zsh')
  expect(clear).not.toHaveBeenCalled()
  store
    .getState()
    .setAgentStatus(pane, { agentType: 'codex', state: 'done', prompt: 'Explain this function' })
  expect(clear).toHaveBeenCalledExactlyOnceWith('tab')
})
