import { describe, expect, it } from 'vitest'
import { linearWorkspaceScopeSignature, type LinearConnectionStatus } from './workspace-types'

describe('linearWorkspaceScopeSignature', () => {
  it('ignores status metadata and workspace ordering', () => {
    const first: LinearConnectionStatus = {
      connected: true,
      viewer: { displayName: 'Ada', email: 'ada@example.com', organizationName: 'Alpha' },
      selectedWorkspaceId: 'workspace-1',
      workspaces: [
        {
          id: 'workspace-1',
          organizationId: 'org-1',
          organizationName: 'Alpha',
          displayName: 'Ada',
          email: 'ada@example.com'
        },
        {
          id: 'workspace-2',
          organizationId: 'org-2',
          organizationName: 'Beta',
          displayName: 'Ada',
          email: 'ada@example.com'
        }
      ]
    }
    const second: LinearConnectionStatus = {
      ...first,
      viewer: { ...first.viewer!, organizationName: 'Renamed' },
      workspaces: [
        { ...first.workspaces![1], organizationName: 'Renamed Beta' },
        { ...first.workspaces![0], organizationName: 'Renamed Alpha' }
      ]
    }

    expect(linearWorkspaceScopeSignature(second)).toBe(linearWorkspaceScopeSignature(first))
  })

  it('changes when the selected workspace changes', () => {
    const first: LinearConnectionStatus = {
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    }
    const second = { ...first, selectedWorkspaceId: 'workspace-2' }

    expect(linearWorkspaceScopeSignature(second)).not.toBe(linearWorkspaceScopeSignature(first))
  })

  it('changes when the active workspace changes while all workspaces are selected', () => {
    const first: LinearConnectionStatus = {
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'all',
      activeWorkspaceId: 'workspace-1'
    }
    const second = { ...first, activeWorkspaceId: 'workspace-2' }

    expect(linearWorkspaceScopeSignature(second)).not.toBe(linearWorkspaceScopeSignature(first))
  })

  it('changes when a workspace credential revision changes', () => {
    const first: LinearConnectionStatus = {
      connected: true,
      viewer: null,
      workspaces: [
        {
          id: 'workspace-1',
          organizationId: 'org-1',
          organizationName: 'Alpha',
          displayName: 'Ada',
          email: 'ada@example.com',
          credentialRevision: 1
        }
      ]
    }
    const second: LinearConnectionStatus = {
      ...first,
      workspaces: [{ ...first.workspaces![0], credentialRevision: 2 }]
    }

    expect(linearWorkspaceScopeSignature(second)).not.toBe(linearWorkspaceScopeSignature(first))
  })

  it('changes when a workspace or viewer organization url key changes', () => {
    const first: LinearConnectionStatus = {
      connected: true,
      viewer: {
        displayName: 'Ada',
        email: 'ada@example.com',
        organizationName: 'Alpha',
        organizationUrlKey: 'alpha'
      },
      workspaces: [
        {
          id: 'workspace-1',
          organizationId: 'org-1',
          organizationName: 'Alpha',
          displayName: 'Ada',
          email: 'ada@example.com',
          organizationUrlKey: 'alpha'
        }
      ]
    }
    const renamedWorkspaceKey: LinearConnectionStatus = {
      ...first,
      workspaces: [{ ...first.workspaces![0], organizationUrlKey: 'alpha-renamed' }]
    }
    const renamedViewerKey: LinearConnectionStatus = {
      ...first,
      viewer: { ...first.viewer!, organizationUrlKey: 'alpha-renamed' }
    }

    expect(linearWorkspaceScopeSignature(renamedWorkspaceKey)).not.toBe(
      linearWorkspaceScopeSignature(first)
    )
    expect(linearWorkspaceScopeSignature(renamedViewerKey)).not.toBe(
      linearWorkspaceScopeSignature(first)
    )
  })
})
