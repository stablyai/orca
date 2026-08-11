import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../shared/types'
import { resolveFolderWorkspaceExecutionHostId } from './folder-workspace-execution-host'

describe('folder workspace execution host resolution', () => {
  it.each([
    { executionHostId: 'local' as const, connectionId: 'builder' },
    { executionHostId: 'ssh:builder' as const, connectionId: null }
  ])('fails closed for contradictory folder direct authority', (folderWorkspace) => {
    expect(resolveFolderWorkspaceExecutionHostId({ folderWorkspace })).toBeNull()
  })

  it('fails closed for contradictory group direct authority', () => {
    expect(
      resolveFolderWorkspaceExecutionHostId({
        folderWorkspace: {},
        projectGroup: { executionHostId: 'local', connectionId: 'builder' }
      })
    ).toBeNull()
  })

  it('keeps runtime transport projection authoritative over its source connection', () => {
    const folderWorkspace = {
      executionHostId: 'runtime:hub',
      runtimeSourceExecutionHostId: 'ssh:builder',
      connectionId: 'builder'
    } as Pick<FolderWorkspace, 'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'>
    const projectGroup = {
      executionHostId: 'runtime:hub',
      runtimeSourceExecutionHostId: 'ssh:builder',
      connectionId: 'builder'
    } as Pick<ProjectGroup, 'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'>

    expect(resolveFolderWorkspaceExecutionHostId({ folderWorkspace })).toBe('runtime:hub')
    expect(resolveFolderWorkspaceExecutionHostId({ folderWorkspace: {}, projectGroup })).toBe(
      'runtime:hub'
    )
  })
})
