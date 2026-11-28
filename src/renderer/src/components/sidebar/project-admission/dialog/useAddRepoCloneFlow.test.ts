// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAddRepoCloneFlow } from './useAddRepoCloneFlow'
import { writeCloneParentFolder } from '../create/clone-parent-memory'

const CLONE_STEP = 'clone' as const

function renderCloneFlow(step: 'add' | 'clone' = CLONE_STEP): {
  result: { current: ReturnType<typeof useAddRepoCloneFlow> }
} {
  return renderHook(() =>
    useAddRepoCloneFlow({
      step,
      hostId: 'local',
      activeRuntimeEnvironmentId: null,
      workspaceDir: '/home/me/orca/workspaces',
      fetchWorktrees: async () => ({})
    } as unknown as Parameters<typeof useAddRepoCloneFlow>[0])
  )
}

describe('useAddRepoCloneFlow parent folder', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('seeds the remembered folder ahead of the workspace default', () => {
    writeCloneParentFolder('local', '/home/me/work/repos', window.localStorage)
    const { result } = renderCloneFlow()
    expect(result.current.cloneDestination).toBe('/home/me/work/repos')
  })

  it('falls back to the workspace default when nothing is remembered', () => {
    const { result } = renderCloneFlow()
    expect(result.current.cloneDestination).toBe('/home/me/orca')
  })
})
