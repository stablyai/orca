import '../../../src/main/runtime/orca-runtime-tests/runtime-test-module-registration.spec'
import { afterEach, expect, it, vi } from 'vitest'
import { applyPtyBinding } from '../../../src/main/persistence/loading-store/terminal-bindings/pty-binding-session-update'
import { committingSpawn } from '../../../src/main/runtime/orca-runtime-tests/bind-first-pane.test-fixture'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import {
  TEST_WORKTREE_ID as WT,
  TEST_WORKTREE_PATH
} from '../../../src/main/runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-session-contracts'
import type { RuntimePtyController } from '../../../src/main/runtime/terminal/lifecycle/runtime-pty-controller-contract'
import { createRuntimeFixture } from './active-tab-publication.test-fixture'

afterEach(() => vi.useRealTimers())

it('publishes admitted terminal placement independently of the selected split group', async () => {
  vi.useFakeTimers()
  const { runtime, runtimeStore, getSession } = createRuntimeFixture(false)
  const ids = ['serve-active']
  runtimeStore.persistPtyBinding = vi.fn(async (input) => {
    const args = typeof input === 'function' ? input() : input
    if (!args) {
      return false
    }
    applyPtyBinding(args, getSession(), args.worktreeId, `${args.tabId}:${args.leafId}`)
    return true
  })
  const controller: RuntimePtyController = {
    spawn: committingSpawn(runtime, async () => {
      const id = `serve-created-${ids.length}`
      ids.push(id)
      return { id }
    }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => ids.map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'sh' }))
  }
  runtime.setPtyController(controller)
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const list = () => runtime.listMobileSessionTabs(`id:${WT}`)
  const second = await runtime.createMobileSessionTerminal(`id:${WT}`, { activate: false })
  const firstGroup = (await list()).tabGroups![0]!.id
  await runtime.moveMobileSessionTab(`id:${WT}`, {
    kind: 'split',
    tabId: second.tab.parentTabId,
    targetGroupId: firstGroup,
    splitDirection: 'right'
  })
  const right = (await list()).tabGroups!.find((group) => group.id !== firstGroup)!.id
  const phone = await runtime.createMobileSessionTerminal(`id:${WT}`, {
    activate: false,
    targetGroupId: right
  })
  const selected = await list()
  expect(selected.activeGroupId).toBe(right)
  await vi.runAllTimersAsync()
  const seen: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))

  const created = await runtime.createTerminal(`id:${WT}`, { focus: false })
  expect(created.tabId).toBeDefined()
  const saved = getSession().tabGroups![WT]!
  expect(saved.find((group) => group.id === firstGroup)?.tabOrder).toContain(created.tabId)
  expect(saved.find((group) => group.id === right)?.tabOrder).not.toContain(created.tabId)
  const result = await list()
  await vi.runAllTimersAsync()
  const expected = [
    [firstGroup, ['serve-tab', created.tabId]],
    [right, [second.tab.parentTabId, phone.tab.parentTabId]]
  ]
  expect(result.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual(expected)
  expect(seen.at(-1)?.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual(expected)
  expect(result.activeGroupId).toBe(right)
  expect(result.activeTabId).toBe(selected.activeTabId)

  const reloaded = new OrcaRuntimeService(runtimeStore)
  reloaded.setPtyController(controller)
  const cold = await reloaded.listMobileSessionTabs(`id:${WT}`)
  expect(cold.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual(expected)
})
