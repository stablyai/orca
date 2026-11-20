import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: { activeWorktreeId: 'workspace-1', activeView: 'terminal' },
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('./workspace/activation/wsl-moved-chat-activation', () => ({
  activateWslMovedWorkspace: () => false
}))

import { activateAiVaultStructuredSession } from './agent-session/open/activate-ai-vault-structured-session'

const structuredSession = {
  structuredSession: { sessionId: 'session-1', workspaceId: 'workspace-1' }
}

const deps = () => ({
  activate: vi.fn(() => true),
  tabs: vi.fn(() => [{ id: 'issued', sessionId: 'session-1' }]),
  refresh: vi.fn(async () => undefined),
  reveal: vi.fn(async () => ({ sessionId: 'session-1', worktreeId: 'workspace-1' })),
  unavailable: vi.fn(),
  gone: vi.fn(),
  hostCannotOpen: vi.fn()
})

describe('activateAiVaultStructuredSession view', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
  })

  it('leaves Settings to show a chat in the workspace it covers (an Open in Orca link)', async () => {
    mocks.state = { activeWorktreeId: 'workspace-1', activeView: 'settings' }

    await activateAiVaultStructuredSession(structuredSession, deps(), { kind: 'local' })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('workspace-1')
  })

  it('leaves an already shown workspace alone', async () => {
    mocks.state = { activeWorktreeId: 'workspace-1', activeView: 'terminal' }

    await activateAiVaultStructuredSession(structuredSession, deps(), { kind: 'local' })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
