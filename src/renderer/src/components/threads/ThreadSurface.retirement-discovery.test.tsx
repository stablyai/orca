// @vitest-environment happy-dom
import {
  W,
  ordinary,
  first,
  second,
  classify,
  Desktop,
  visibleConversation,
  main,
  replaceMain,
  pendingPhoneClose,
  countRetirementDiscovery
} from './thread-surface.test-fixture'
import { act, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeTabGroup } from '@/store/slices/store-test-helpers'
import { openNewThread } from './thread-actions'
import { navigateDesktopTab } from '@/lib/desktop-navigation'
import { drawTabsFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { useThreadDraft } from './thread-navigation'

it.each([20, 200])(
  'pending retirement discovers one current scoped target at N=%i',
  async (count) => {
    for (const input of ['ordinary-off', 'thread', 'thread-then-draft']) {
      const enabled = input !== 'ordinary-off'
      const thenDraft = input === 'thread-then-draft'
      main.close()
      const fillers = Array.from({ length: count - 2 }, (_, i) => ({
        ...first,
        id: `filler-${i}`,
        entityId: `filler-${i}`
      }))
      const tabs = [...fillers, first, second, ordinary]
      useAppStore.setState({
        activeView: 'terminal',
        settings: { ...useAppStore.getState().settings!, experimentalThreads: enabled },
        unifiedTabsByWorktree: { [W]: tabs },
        groupsByWorktree: {
          [W]: [
            makeTabGroup({
              id: 'g',
              worktreeId: W,
              activeTabId: second.id,
              tabOrder: tabs.map((t) => t.id),
              recentTabIds: [ordinary.id, first.id, second.id]
            })
          ]
        }
      })
      replaceMain(await drawTabsFromMain(useAppStore))
      useAppStore.setState({
        unifiedTabsByWorktree: {
          prefix: fillers.map((t) => ({ ...t, worktreeId: 'prefix' })),
          ...useAppStore.getState().unifiedTabsByWorktree
        }
      })
      classify(ordinary)
      const rendered = render(<Desktop />)
      let capture: ReturnType<typeof countRetirementDiscovery> | undefined
      const finish = await pendingPhoneClose(second.id, () => {
        capture = countRetirementDiscovery('capture')
      })
      capture!.restore()
      expect.soft(capture!.counts).toEqual({ target: count, otherWorkspace: 0, group: 2 })
      act(() => navigateDesktopTab(ordinary.id))
      if (thenDraft) {
        await act(async () => openNewThread())
      }
      const discovery = countRetirementDiscovery()
      try {
        await finish()
      } finally {
        discovery.restore()
      }
      expect(useAppStore.getState().unifiedTabsByWorktree[W]).toHaveLength(count)
      expect(useAppStore.getState().getActiveTab(W)?.id).toBe(enabled ? ordinary.id : first.id)
      if (thenDraft) {
        expect(screen.getByText(`Draft ${useThreadDraft.getState().draft!.draftId}`)).toBeTruthy()
      } else {
        expect(visibleConversation()).toEqual([enabled ? ordinary.entityId : first.entityId])
      }
      console.info('retirement discovery', { count, input, ...discovery.counts })
      expect.soft(discovery.counts.target).toBe(enabled ? count : 0)
      expect.soft(discovery.counts.otherWorkspace).toBe(0)
      expect.soft(discovery.counts.group).toBe(enabled ? 1 : 0)
      rendered.unmount()
    }
  }
)

it.each([
  'missing',
  'moved-workspace',
  'moved-bucket',
  'moved-group',
  'moved-host',
  'deselected',
  'missing-group',
  'other-workspace',
  'other-group'
] as const)(
  'pending retirement revalidates current target after frame/settlement: %s',
  async (change) => {
    render(<Desktop />)
    const finish = await pendingPhoneClose(second.id)
    act(() => {
      if (change === 'other-workspace' || change === 'other-group') {
        const target = {
          ...ordinary,
          id: 'elsewhere',
          worktreeId: change === 'other-workspace' ? 'elsewhere' : W,
          groupId: 'elsewhere'
        }
        useAppStore.setState((s) => ({
          unifiedTabsByWorktree: {
            ...s.unifiedTabsByWorktree,
            [target.worktreeId]: [...(s.unifiedTabsByWorktree[target.worktreeId] ?? []), target]
          },
          groupsByWorktree: {
            ...s.groupsByWorktree,
            [target.worktreeId]: [
              ...(s.groupsByWorktree[target.worktreeId] ?? []),
              makeTabGroup({
                id: 'elsewhere',
                worktreeId: target.worktreeId,
                tabOrder: [target.id]
              })
            ]
          }
        }))
        navigateDesktopTab(target.id)
      } else {
        navigateDesktopTab(ordinary.id)
      }
    })
    await act(async () => openNewThread())
    const { afterPendingTab } = await import('@/runtime/layout-owner-pending-tabs')
    afterPendingTab(second.id, () => {
      const s = useAppStore.getState()
      if (change === 'other-workspace' || change === 'other-group') {
        return
      }
      useAppStore.setState({
        unifiedTabsByWorktree: {
          ...s.unifiedTabsByWorktree,
          ...(change === 'moved-bucket'
            ? { elsewhere: [{ ...ordinary, worktreeId: 'elsewhere' }] }
            : {}),
          [W]: s.unifiedTabsByWorktree[W]
            .filter(
              (t) => (change !== 'missing' && change !== 'moved-bucket') || t.id !== ordinary.id
            )
            .map((t) =>
              t.id !== ordinary.id
                ? t
                : {
                    ...t,
                    worktreeId: change === 'moved-workspace' ? 'elsewhere' : t.worktreeId,
                    groupId: change === 'moved-group' ? 'elsewhere' : t.groupId,
                    executionHostId: change === 'moved-host' ? 'other-host' : t.executionHostId
                  }
            )
        },
        groupsByWorktree: {
          ...s.groupsByWorktree,
          [W]:
            change === 'missing-group'
              ? []
              : s.groupsByWorktree[W].map((g) => ({
                  ...g,
                  activeTabId: change === 'deselected' ? first.id : g.activeTabId
                }))
        }
      })
    })
    const discovery = countRetirementDiscovery()
    try {
      await finish()
    } finally {
      discovery.restore()
    }
    expect(useAppStore.getState().getActiveTab(W)?.id ?? null).toBe(
      change === 'missing-group' ? null : first.id
    )
    expect(screen.getByText(`Draft ${useThreadDraft.getState().draft!.draftId}`)).toBeTruthy()
    if (change === 'other-workspace' || change === 'other-group') {
      expect(discovery.counts).toEqual({ target: 0, otherWorkspace: 0, group: 0 })
    } else {
      expect(discovery.counts.target).toBeLessThanOrEqual(2)
      expect(discovery.counts.otherWorkspace).toBe(0)
      expect(discovery.counts.group).toBeLessThanOrEqual(1)
    }
  }
)
