import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { LayoutApplyParams } from '../../../shared/rpc-contract/workspace-layout-params'
import { applyDefaultTerminalTabs } from './worktree-default-terminal-tabs'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(async (_target: unknown, _method: string, _params: unknown) => ({
    ok: true,
    result: {}
  }))
}))

vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const NO_TEMPLATES = { runCommands: false, tabs: [] }

const store = useAppStore
let initialState: AppState

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  initialState = store.getState()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
})

afterEach(() => {
  store.setState(initialState, true)
})

function applyNoTemplates(): string | null {
  return applyDefaultTerminalTabs(
    store.getState(),
    WT,
    undefined,
    undefined,
    undefined,
    NO_TEMPLATES,
    undefined,
    undefined
  )
}

function sentCommands() {
  return mocks.callRuntimeRpc.mock.calls.map(([, method, params]) => {
    expect(method).toBe('layout.apply')
    return LayoutApplyParams.parse(params).command
  })
}

describe('the default-tabs mark in a layout-owner build', () => {
  it('records the mark in main when a workspace has no default tab templates', () => {
    expect(applyNoTemplates()).toBeNull()

    expect(store.getState().tabsByWorktree[WT]).toBeUndefined()
    expect(sentCommands()).toEqual([{ type: 'setDefaultTabsApplied', workspace: WT }])
  })

  it('records the mark after the default tabs, so main never holds it without their rows', () => {
    const tabId = applyDefaultTerminalTabs(
      store.getState(),
      WT,
      undefined,
      undefined,
      undefined,
      { runCommands: false, tabs: [{ title: 'one' }, { title: 'two' }] },
      undefined,
      undefined
    )

    expect(tabId).not.toBeNull()
    expect(sentCommands().map((command) => command.type)).toEqual([
      'createTerminalTab',
      'renameTab',
      'createTerminalTab',
      'renameTab',
      'setDefaultTabsApplied'
    ])
  })

  it('records it once: a workspace already marked sends nothing', () => {
    applyNoTemplates()
    mocks.callRuntimeRpc.mockClear()

    store.getState().markDefaultTerminalTabsApplied(WT)
    applyNoTemplates()

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends nothing with the switch off', () => {
    mocks.layoutOwnerIsMain = false

    applyNoTemplates()

    expect(store.getState().defaultTerminalTabsAppliedByWorktreeId[WT]).toBe(true)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
