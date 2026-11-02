import { describe, expect, it } from 'vitest'
import { getFolderWorkspaceHostId } from '../../../shared/folder-workspace-execution-host'
import { FOLDER_HOST_CASES } from '../../../shared/folder-workspace-host-routing.test-fixture'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { adoptFromEndpoint } from '../store/adopt-from-endpoint'
import { buildHostIdByWorktreeId } from './workspace-session-host-persistence'

// Main's router is checked against the same table in folder-workspace-mixed-host-routing.test.ts.
describe("the window's save partition for each folder kind local main lists", () => {
  it.each(FOLDER_HOST_CASES)('$name', ({ folder, groups, expected }) => {
    const local = { kind: 'local' } as const
    const stampedGroups = groups.map((row) =>
      adoptFromEndpoint(local, { kind: 'projectGroup', row })
    )
    const stampedFolder = adoptFromEndpoint(local, {
      kind: 'folderWorkspace',
      row: folder,
      // As the window's catalog resolver does, over the groups it already stamped.
      resolveOwnHostId: (row) => getFolderWorkspaceHostId(row, stampedGroups)
    })
    const hostIdOf = buildHostIdByWorktreeId({
      repos: [],
      projectGroups: stampedGroups,
      folderWorkspaces: [stampedFolder],
      worktreesByRepo: {}
    })
    expect(hostIdOf(folderWorkspaceKey(folder.id))).toBe(expected)
  })
})
