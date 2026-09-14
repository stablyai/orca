import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { gateWorktreeAgentActivation } from '@/lib/worktree-agent-activation-gate'
import { resolveWorkspaceTerminalHostAuthority } from '@/lib/workspace-terminal-host-authority'
import type { WorkspaceMultiplexerSlot } from '../../../../shared/workspace-multiplexer-types'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'
import { ensureWorkspaceMultiplexerTerminal } from './workspace-multiplexer-initial-terminal'

vi.mock('@/lib/worktree-agent-activation-gate', () => ({ gateWorktreeAgentActivation: vi.fn() }))
vi.mock('@/lib/workspace-terminal-host-authority', () => ({
  resolveWorkspaceTerminalHostAuthority: vi.fn()
}))
const initialState = useAppStore.getState()
const slot: WorkspaceMultiplexerSlot = {
  id: 'slot',
  worktreeId: 'worktree',
  executionHostId: 'local',
  groupId: 'group',
  activeTerminalTabId: null
}
const workspace = {
  worktreeId: slot.worktreeId,
  executionHostId: 'local'
} as WorkspaceMultiplexerCatalogItem

beforeEach(() => {
  vi.mocked(gateWorktreeAgentActivation).mockResolvedValue('empty')
  vi.mocked(resolveWorkspaceTerminalHostAuthority).mockReturnValue('none')
  useAppStore.setState({
    workspaceMultiplexer: { slots: [slot], panes: [], layout: null },
    unifiedTabsByWorktree: {},
    groupsByWorktree: {
      worktree: [{ id: 'group', worktreeId: 'worktree', tabOrder: [], activeTabId: null }]
    },
    activeWorktreeId: 'worktree',
    activeGroupIdByWorktree: { worktree: 'group' },
    createTab: vi.fn()
  })
})
afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

it('queries existing agent ownership but never seeds a shell for an add offer', async () => {
  await ensureWorkspaceMultiplexerTerminal(slot, workspace, false)
  expect(gateWorktreeAgentActivation).toHaveBeenCalledWith('worktree')
  expect(useAppStore.getState().createTab).not.toHaveBeenCalled()
})

it.each(['adopted', 'resumed', 'structured', 'blocked'] as const)(
  'does not seed after %s',
  async (outcome) => {
    vi.mocked(gateWorktreeAgentActivation).mockResolvedValue(outcome)
    await ensureWorkspaceMultiplexerTerminal(slot, workspace, true)
    expect(useAppStore.getState().createTab).not.toHaveBeenCalled()
  }
)

it('seeds an explicitly added empty workspace in its own group', async () => {
  await ensureWorkspaceMultiplexerTerminal(slot, workspace, true)
  expect(useAppStore.getState().createTab).toHaveBeenCalledWith('worktree', 'group', undefined, {
    activate: true,
    recordInteraction: false
  })
})

it('does not steal focus when another workspace is selected during inventory lookup', async () => {
  vi.mocked(gateWorktreeAgentActivation).mockImplementation(async () => {
    useAppStore.setState({ activeWorktreeId: 'other' })
    return 'empty'
  })
  await ensureWorkspaceMultiplexerTerminal(slot, workspace, true)
  expect(useAppStore.getState().createTab).toHaveBeenCalledWith('worktree', 'group', undefined, {
    activate: false,
    recordInteraction: false
  })
})

it('does not recreate a terminal after its slot is removed during inventory lookup', async () => {
  vi.mocked(gateWorktreeAgentActivation).mockImplementation(async () => {
    useAppStore.setState({ workspaceMultiplexer: { slots: [], panes: [], layout: null } })
    return 'empty'
  })
  await ensureWorkspaceMultiplexerTerminal(slot, workspace, true)
  expect(useAppStore.getState().createTab).not.toHaveBeenCalled()
})

it.each(['live', 'unverifiable'] as const)(
  'leaves %s remote ownership to host hydration',
  async (authority) => {
    vi.mocked(resolveWorkspaceTerminalHostAuthority).mockReturnValue(authority)
    await ensureWorkspaceMultiplexerTerminal(slot, workspace, true)
    expect(gateWorktreeAgentActivation).not.toHaveBeenCalled()
    expect(useAppStore.getState().createTab).not.toHaveBeenCalled()
  }
)
