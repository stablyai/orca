import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from './folder-workspace-types'
import {
  filterFolderWorkspacesFromOtherDevices,
  isWorkspaceOwnedBySomeoneElse
} from './workspace-creator-visibility'

function makeFolderWorkspace(
  id: string,
  creatorProvenance: FolderWorkspace['creatorProvenance']
): FolderWorkspace {
  return {
    id,
    projectGroupId: 'project',
    name: id,
    folderPath: `/tmp/${id}`,
    executionHostId: 'runtime:env-1',
    creatorProvenance,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('filterFolderWorkspacesFromOtherDevices', () => {
  it('uses the same client ownership rules as git workspaces', () => {
    const own = makeFolderWorkspace('own', {
      kind: 'paired-device',
      deviceId: 'device-a'
    })
    const other = makeFolderWorkspace('other', {
      kind: 'paired-device',
      deviceId: 'device-b'
    })
    const host = makeFolderWorkspace('host', { kind: 'host' })
    const legacy = makeFolderWorkspace('legacy', undefined)

    const result = filterFolderWorkspacesFromOtherDevices(
      [own, other, host, legacy],
      new Map([['env-1', 'device-a']])
    )

    expect(result.map((workspace) => workspace.id)).toEqual(['own', 'legacy'])
  })
})

describe('isWorkspaceOwnedBySomeoneElse', () => {
  const desktopOnServer = new Map([['server', 'desktop']])
  // What resolveRpcWorkspaceCreatorProvenance records for each creator.
  const created = {
    byThisHostOrItsPhone: { kind: 'host' },
    byPairedDesktopOrItsRelayedPhone: { kind: 'paired-device', deviceId: 'desktop' },
    byAnotherClientOrItsPhone: { kind: 'paired-device', deviceId: 'laptop' },
    byLegacyPhone: { kind: 'paired-device', deviceId: 'phone' }
  } as const

  function hidden(creatorProvenance: unknown, runtimeOwnerEnvironmentId?: string): boolean {
    return isWorkspaceOwnedBySomeoneElse(
      { creatorProvenance, runtimeOwnerEnvironmentId },
      desktopOnServer
    )
  }

  it("keeps a local row this desktop or its phone created, and hides other clients'", () => {
    expect(hidden(created.byThisHostOrItsPhone)).toBe(false)
    expect(hidden(created.byAnotherClientOrItsPhone)).toBe(true)
  })

  it('keeps a legacy local phone row hidden: an older host recorded the phone, not its owner', () => {
    expect(hidden(created.byLegacyPhone)).toBe(true)
  })

  it('keeps a server row this desktop or its relayed phone created', () => {
    expect(hidden(created.byPairedDesktopOrItsRelayedPhone, 'server')).toBe(false)
  })

  it('hides a server row another client, its phone, or the server itself created', () => {
    expect(hidden(created.byAnotherClientOrItsPhone, 'server')).toBe(true)
    expect(hidden(created.byThisHostOrItsPhone, 'server')).toBe(true)
  })

  it('keeps rows with no creator, or on a server whose pairing is unknown', () => {
    expect(hidden(undefined)).toBe(false)
    expect(hidden(undefined, 'server')).toBe(false)
    expect(hidden(created.byAnotherClientOrItsPhone, 'unpaired')).toBe(false)
  })
})
