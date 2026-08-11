import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearActiveAgentTerminalBindingCacheForTests,
  getActiveAgentTerminalBindingCacheSizeForTests,
  resolveActiveAgentTerminal
} from './active-agent-note-terminal-binding'

const testState = vi.hoisted(() => ({
  findActiveRuntimeTerminal: vi.fn(),
  directSshGeneration: 0,
  environmentGeneration: 0,
  environmentSshGeneration: 0,
  nestedSshGeneration: 0
}))

vi.mock('./active-agent-note-target', () => ({
  findActiveRuntimeTerminal: testState.findActiveRuntimeTerminal
}))

vi.mock('@/store/slices/ssh', () => ({
  getLocalSshTargetConnectionGeneration: () => testState.directSshGeneration
}))

vi.mock('@/store/slices/runtime-status', () => ({
  getRuntimeEnvironmentConnectionGeneration: () => testState.environmentGeneration
}))

vi.mock('@/store/slices/runtime-environment-ssh', () => ({
  getEnvironmentSshStateGeneration: () => testState.environmentSshGeneration,
  getEnvironmentSshTargetConnectionGeneration: () => testState.nestedSshGeneration
}))

vi.mock('@/runtime/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => 0
}))

describe('active agent note terminal binding', () => {
  beforeEach(() => {
    clearActiveAgentTerminalBindingCacheForTests()
    testState.directSshGeneration = 0
    testState.environmentGeneration = 0
    testState.environmentSshGeneration = 0
    testState.nestedSshGeneration = 0
    testState.findActiveRuntimeTerminal.mockReset()
    testState.findActiveRuntimeTerminal.mockImplementation(
      async (_runtimeTarget, worktreeId, noteTarget) => ({
        handle: `term-${worktreeId}`,
        ptyId: `pty-${worktreeId}`,
        worktreeId,
        worktreePath: '/repo',
        branch: 'main',
        tabId: noteTarget.tabId,
        leafId: noteTarget.leafId,
        title: 'Codex',
        connected: true,
        writable: true,
        lastOutputAt: 1,
        preview: ''
      })
    )
  })

  it('bounds retained pane bindings and evicts the oldest entry', async () => {
    const state = {} as Parameters<typeof resolveActiveAgentTerminal>[0]
    const runtimeTarget = { kind: 'local' } as const
    const resolve = async (index: number): Promise<void> => {
      await resolveActiveAgentTerminal(state, runtimeTarget, `worktree-${index}`, {
        tabId: `tab-${index}`,
        leafId: `leaf-${index}`
      })
    }

    for (let index = 0; index < 129; index += 1) {
      await resolve(index)
    }

    expect(getActiveAgentTerminalBindingCacheSizeForTests()).toBe(128)
    expect(testState.findActiveRuntimeTerminal).toHaveBeenCalledTimes(129)

    await resolve(0)
    await resolve(128)

    expect(getActiveAgentTerminalBindingCacheSizeForTests()).toBe(128)
    expect(testState.findActiveRuntimeTerminal).toHaveBeenCalledTimes(130)
  })

  it('invalidates a folder binding when its direct SSH authority reconnects', async () => {
    const worktreeId = 'folder:ssh-folder'
    const state = {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'ssh:ssh-a'
    } as Parameters<typeof resolveActiveAgentTerminal>[0]
    const resolve = async (): Promise<void> => {
      await resolveActiveAgentTerminal(state, { kind: 'local' }, worktreeId, {
        tabId: 'tab-folder',
        leafId: 'leaf-folder'
      })
    }

    await resolve()
    await resolve()
    testState.directSshGeneration += 1
    await resolve()

    expect(testState.findActiveRuntimeTerminal).toHaveBeenCalledTimes(2)
  })

  it('invalidates a nested SSH binding when its paired host reconnects', async () => {
    const worktreeId = 'repo-a::worktree-a'
    const state = {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'ssh:ssh-a',
      worktreesByRepo: {
        'repo-a': [
          {
            id: worktreeId,
            repoId: 'repo-a',
            hostId: 'ssh:ssh-a',
            runtimeOwnerEnvironmentId: 'environment-a'
          }
        ]
      }
    } as Parameters<typeof resolveActiveAgentTerminal>[0]
    const runtimeTarget = { kind: 'environment', environmentId: 'environment-a' } as const
    const resolve = async (): Promise<void> => {
      await resolveActiveAgentTerminal(state, runtimeTarget, worktreeId, {
        tabId: 'tab-nested',
        leafId: 'leaf-nested'
      })
    }

    await resolve()
    await resolve()
    testState.nestedSshGeneration += 1
    await resolve()

    expect(testState.findActiveRuntimeTerminal).toHaveBeenCalledTimes(2)
  })
})
