import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { readWorkspaceFileDragSource } from './workspace-file-drag'
import { writeWorkspaceFileDragSourceForWorkspace } from './workspace-file-drag-source'

const mocks = vi.hoisted((): { host: ExecutionHostId | null; environmentId: string | null } => ({
  host: 'ssh:target-a',
  environmentId: null
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: { activeRuntimeEnvironmentId: 'foreign-env' } }) }
}))
vi.mock('./worktree-runtime-owner', () => ({
  getKnownExecutionHostIdForWorktree: () => mocks.host,
  getExplicitRuntimeEnvironmentIdForWorktree: () => mocks.environmentId
}))

describe('workspace drag source server namespace', () => {
  beforeEach(() => {
    mocks.host = 'ssh:target-a'
    mocks.environmentId = null
  })

  it.each([null, 'env-a'])('stamps SSH ownership from its workspace: %s', (environmentId) => {
    mocks.environmentId = environmentId
    const payload = new Map<string, string>()
    writeWorkspaceFileDragSourceForWorkspace(
      { setData: (type, value) => payload.set(type, value) },
      'folder:source'
    )
    expect(readWorkspaceFileDragSource({ getData: (type) => payload.get(type) ?? '' })).toEqual({
      executionHostId: 'ssh:target-a',
      workspaceId: 'folder:source',
      ...(environmentId ? { runtimeEnvironmentId: environmentId } : {})
    })
  })

  it('leaves an unknown workspace unstamped despite the focused server', () => {
    mocks.host = null
    const setData = vi.fn()
    writeWorkspaceFileDragSourceForWorkspace({ setData }, 'folder:missing')
    expect(setData).not.toHaveBeenCalled()
  })
})
