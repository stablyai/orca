import { makeTab, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { applyAgentStatusPatch } from '@/store/agent-status-patch'
// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getTabAgentExitOwner } from './tab-agent-exit-owner'
import { useTabAgent } from './use-tab-agent'

const initial = getAgentStatusOwner(useAppStore).getState()
const owner = getAgentStatusOwner(useAppStore)
let stop = () => {}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  stop()
  owner.transact((transaction) => {
    for (const key of Object.keys(owner.getSnapshot())) {
      transaction.setEntry(key, undefined)
    }
    applyAgentStatusPatch(useAppStore, initial)
  })
})

it('reads scoped root history across mount, removal, generation reset and new keyed panes', () => {
  vi.useFakeTimers()
  const tab: TerminalTab = makeTab({
    id: 'icons',
    ptyId: null,
    worktreeId: 'wt',
    title: 'zsh',
    launchAgent: 'codex',
    createdAt: 0
  })
  const items: Tab[] = ['codex', 'zsh'].map((label, n) =>
    makeUnifiedTab({
      id: `item-${n}`,
      entityId: tab.id,
      worktreeId: 'wt',
      groupId: `g${n}`,
      label,
      sortOrder: n,
      createdAt: 0
    })
  )
  applyAgentStatusPatch(useAppStore, {
    tabsByWorktree: { wt: [tab] },
    ptyIdsByTabId: { icons: ['pty-a'] },
    unifiedTabsByWorktree: { wt: items },
    layoutByWorktree: {
      wt: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'g0' },
        second: { type: 'leaf', groupId: 'g1' }
      }
    }
  })
  const service = getTabAgentExitOwner(owner)
  stop = service.start()
  function Icon() {
    return <span>{useTabAgent({ ...tab, title: 'zsh' }, 'g0') ?? 'none'}</span>
  }
  expect(renderToStaticMarkup(<Icon />)).toBe('<span>none</span>')
  const clear = vi.fn(useAppStore.getState().clearTabLaunchAgent)
  applyAgentStatusPatch(useAppStore, { clearTabLaunchAgent: clear })
  const first = renderHook(() => useTabAgent({ ...tab, title: 'zsh' }, 'g0'))
  const second = renderHook(() => useTabAgent({ ...tab, title: 'zsh' }, 'g1'))
  expect(first.result.current).toBeNull()
  expect(second.result.current).toBe('codex')
  expect(clear).not.toHaveBeenCalled()
  first.unmount()
  second.unmount()
  const changed = vi.fn()
  const unrelated = vi.fn()
  const release = owner.subscribeTab('icons', changed)
  const releaseOther = owner.subscribeTab('other', unrelated)
  const pane = makePaneKey('icons', '11111111-1111-4111-8111-111111111111')
  act(() =>
    useAppStore
      .getState()
      .setAgentStatus(pane, { state: 'working', agentType: 'codex', prompt: 'task' })
  )
  expect(changed).toHaveBeenCalledTimes(1)
  expect(unrelated).not.toHaveBeenCalled()
  const remount = renderHook(() => useTabAgent(tab, 'g1'))
  expect(remount.result.current).toBe('codex')
  act(() => {
    owner.transact((transaction) => {
      transaction.setEntry(pane, undefined)
      applyAgentStatusPatch(useAppStore, {
        ptyIdsByTabId: { icons: ['pty-b'] },
        unifiedTabsByWorktree: { wt: items.map((item) => ({ ...item, label: 'zsh' })) }
      })
    })
  })
  expect(service.getObservation('wt', 'icons', 'g0')).toBe(false)
  expect(service.getObservation('wt', 'icons', 'g1')).toBe(false)
  expect(remount.result.current).toBe('codex')
  expect(clear).not.toHaveBeenCalled()
  act(() => applyAgentStatusPatch(useAppStore, { tabsByWorktree: { wt: [] } }))
  expect(service.getObservation('wt', 'icons', 'g0')).toBe(false)
  release()
  releaseOther()
})
