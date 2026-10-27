import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { FolderWorkspacePathStatus } from '../../../shared/folder-workspace-path-status'
import {
  formatFolderWorkspaceCreateError,
  humanizeFolderWorkspacePathError,
  getFolderWorkspacePathErrorCopy,
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from './folder-workspace-path-status'

// RPC returns z.unknown and casts it; tests must cover newer-host wire values outside this build’s union.
function wireStatus(reason: unknown): FolderWorkspacePathStatus {
  return { path: '/srv/scans', exists: false, reason } as unknown as FolderWorkspacePathStatus
}

describe('getFolderWorkspacePathStatusTitle', () => {
  it('still titles a broken folder when a newer host sends an undeclared reason', () => {
    const title = getFolderWorkspacePathStatusTitle(wireStatus('permission-denied'))

    expect(typeof title).toBe('string')
    expect(title).not.toBe('')
  })

  // hasOwn coerces [missing] into a valid key; reject arrays before the switch (#15002).
  it('does not admit a non-string reason through the membership guard', () => {
    const title = getFolderWorkspacePathStatusTitle(wireStatus(['missing']))

    expect(typeof title).toBe('string')
    expect(title).not.toBe('')
    expect(title).not.toBe('Folder not found')
  })
})

describe('getFolderWorkspacePathStatusDescription', () => {
  it('still describes a broken folder when a newer host sends an undeclared reason', () => {
    const description = getFolderWorkspacePathStatusDescription(wireStatus('permission-denied'))

    expect(typeof description).toBe('string')
    expect(description).not.toBe('')
    expect(description).toContain('/srv/scans')
  })

  it('does not admit a non-string reason through the membership guard', () => {
    const description = getFolderWorkspacePathStatusDescription(wireStatus(['missing']))

    expect(typeof description).toBe('string')
    expect(description).not.toBe('')
    expect(description).not.toBe(
      'Orca cannot find /srv/scans. Remove and re-import this folder workspace.'
    )
  })
})

describe('getFolderWorkspacePathErrorCopy', () => {
  it('maps the ambiguous-connection code the runtime throws without a path', () => {
    expect(
      getFolderWorkspacePathErrorCopy(
        "Error invoking remote method 'pty:spawn': Error: folder_workspace_connection_ambiguous"
      )?.title
    ).toBe('Cannot determine connection')
  })
})

it.each(['/srv/project: folder', 'C:\\work\\My Project:backup', '/tmp/$& folder'])(
  'preserves a literal path %s and IPC wrapper',
  (path) => {
    const prefix = "Error invoking remote method 'pty:spawn': Error: "
    expect(humanizeFolderWorkspacePathError(`${prefix}folder_workspace_path_missing:${path}`)).toBe(
      `${prefix}Orca cannot find ${path}. Remove and re-import the folder.`
    )
  }
)

it.each([
  'not_folder_workspace_path_missing:/x',
  'folder_workspace_path_missing_extra:/x',
  'Failed to read /tmp/folder_workspace_path_missing:/x',
  'folder_workspace_path_missing-more',
  'disk full'
])('passes through unknown error %s', (error) => {
  expect(humanizeFolderWorkspacePathError(error)).toBe(error)
  expect(getFolderWorkspacePathErrorCopy(error)).toBeNull()
})

it('preserves multiline paths in the existing create-folder formatter', () => {
  const path = '/tmp/folder\nwith\rline breaks'
  expect(
    formatFolderWorkspaceCreateError(`folder_workspace_path_missing:${path}`).description
  ).toBe(`Orca cannot find ${path}. Remove and re-import the folder.`)
})

it('uses the existing English fallback when a language pack has no folder-path translation', async () => {
  await i18n.changeLanguage('test-missing-folder-copy')
  try {
    expect(humanizeFolderWorkspacePathError('folder_workspace_path_missing:/tmp/project')).toBe(
      'Orca cannot find /tmp/project. Remove and re-import the folder.'
    )
  } finally {
    await i18n.changeLanguage('en')
  }
})
