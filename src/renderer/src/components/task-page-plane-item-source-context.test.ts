import { describe, expect, it } from 'vitest'
import type { PlaneWorkItem } from '../../../shared/plane-types'
import { bindTaskPagePlaneItemSourceContext } from './task-page-plane-item-source-context'

function workItem(overrides: Partial<PlaneWorkItem> = {}): PlaneWorkItem {
  return {
    id: 'wi-1',
    key: 'PROJ-123',
    sequenceId: 123,
    workspaceId: 'ws-1',
    workspaceName: 'acme',
    title: 'Add OAuth login',
    url: 'https://app.plane.so/acme/browse/PROJ-123/',
    project: { id: 'p-1', identifier: 'PROJ', name: 'Platform' },
    state: { id: 's-1', name: 'Todo', group: 'unstarted' },
    labels: [],
    assignees: [],
    priority: 'none',
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

describe('bindTaskPagePlaneItemSourceContext', () => {
  it('records the workspace and project the item came from', () => {
    // Two Plane deployments can own the same PROJ-123, so the link needs to say
    // which connection produced it.
    const context = bindTaskPagePlaneItemSourceContext({
      item: workItem(),
      hostId: null,
      projectId: 'orca-project'
    })
    expect(context).toMatchObject({
      provider: 'plane',
      accountLabel: 'acme',
      providerIdentity: {
        provider: 'plane',
        workspaceId: 'ws-1',
        projectId: 'p-1',
        projectIdentifier: 'PROJ'
      }
    })
  })

  it('returns null rather than a context that cannot be resolved', () => {
    expect(
      bindTaskPagePlaneItemSourceContext({ item: workItem(), hostId: null, projectId: null })
    ).toBeNull()
  })

  it('tolerates a work item that carries no workspace identity', () => {
    const item = workItem()
    delete (item as { workspaceId?: string }).workspaceId
    delete (item as { workspaceName?: string }).workspaceName
    const context = bindTaskPagePlaneItemSourceContext({
      item,
      hostId: null,
      projectId: 'orca-project'
    })
    expect(context?.providerIdentity).toMatchObject({ projectIdentifier: 'PROJ' })
  })
})
