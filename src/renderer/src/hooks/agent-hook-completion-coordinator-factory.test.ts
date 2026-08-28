import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCoordinator = vi.hoisted(() => vi.fn(() => ({}) as never))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: null }) } }))
vi.mock('@/components/terminal-pane/agent-completion-coordinator', () => ({
  createAgentCompletionCoordinator: createCoordinator
}))
vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification: vi.fn()
}))
vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle: vi.fn()
}))

import { createAgentHookCompletionCoordinator } from './agent-hook-completion-coordinator-factory'

describe('agent hook completion coordinator factory', () => {
  beforeEach(() => createCoordinator.mockClear())

  it('does not apply client-local Codex suppression to authoritative remote facts', () => {
    createAgentHookCompletionCoordinator({
      paneKey: 'remote-pane',
      worktreeId: 'remote-worktree',
      authoritativeRemote: true,
      getPtyId: () => null,
      isLive: () => true,
      isTrackingEnabled: () => true,
      requiresFreshWorking: () => false
    })

    expect(createCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ shouldSuppressHookCompletion: undefined })
    )
  })
})
