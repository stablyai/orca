// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useAppStore } from '@/store'
import { handlePluginViewRequest } from './plugin-view-request-handler'

const activation = vi.hoisted(() => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/lib/worktree-activation', () => activation)

const KEY = 'acme.todos'
const TAB = `plugin:${KEY}/todos`
const initialState = useAppStore.getState()

function plugin(): PluginHostListEntry {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler and the stores read only these fields.
  return {
    pluginKey: KEY,
    name: 'Todos',
    status: 'idle',
    panels: [{ id: 'todos', title: 'Todos', tabKey: TAB }],
    customEditors: [],
    commands: []
  } as unknown as PluginHostListEntry
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: open-panel reads only these store members, so partial rows stand in for whole workspaces.
const setStore = (patch: Record<string, unknown>) => useAppStore.setState(patch as never)

const open = () =>
  handlePluginViewRequest({ requestId: 'r', kind: 'open-panel', pluginKey: KEY, panelId: 'todos' })

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { list: vi.fn().mockResolvedValue([plugin()]) } }
  })
  activation.activateAndRevealWorkspace.mockReset()
  activation.activateAndRevealWorkspace.mockImplementation((id: string) => {
    useAppStore.setState({ activeWorktreeId: id })
    return false
  })
})

afterEach(() => useAppStore.setState(initialState, true))

describe('a panel with no workspace showing', () => {
  it('selects one of the workspaces in the hidden window, starting no terminal', async () => {
    setStore({
      activeView: 'terminal',
      activeWorktreeId: null,
      worktreesByRepo: { r1: [{ id: 'wt-1', path: '/w', isArchived: false, lastActivityAt: 1 }] },
      folderWorkspaces: []
    })
    await expect(open()).resolves.toEqual({ requestId: 'r', ok: true })
    expect(activation.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true,
      executionHostId: 'local'
    })
    expect(useAppStore.getState().rightSidebarTab).toBe(TAB)
  })

  it('still fails when Orca has no workspace at all', async () => {
    setStore({
      activeView: 'terminal',
      activeWorktreeId: null,
      worktreesByRepo: {},
      folderWorkspaces: []
    })
    await expect(open()).resolves.toMatchObject({ ok: false, code: 'no_workspace' })
    expect(activation.activateAndRevealWorkspace).not.toHaveBeenCalled()
  })
})
