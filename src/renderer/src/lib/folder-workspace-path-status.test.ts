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

// Why: the status crosses the runtime RPC wire and is cast, not decoded (`result: z.unknown()`), so
// the cast at the test boundary is the point — a newer host really can put these on the wire.
function wireStatus(reason: unknown): FolderWorkspacePathStatus {
  return { path: '/srv/scans', exists: false, reason } as unknown as FolderWorkspacePathStatus
}

describe('getFolderWorkspacePathStatusTitle', () => {
  it('keeps the declared reasons on their own copy', () => {
    expect(getFolderWorkspacePathStatusTitle(wireStatus('missing'))).toBe('Folder not found')
    expect(getFolderWorkspacePathStatusTitle(wireStatus('not-directory'))).toBe(
      'Path is not a folder'
    )
    expect(getFolderWorkspacePathStatusTitle(wireStatus('ambiguous-connection'))).toBe(
      'Cannot determine connection'
    )
    expect(getFolderWorkspacePathStatusTitle(wireStatus('unavailable'))).toBe('Cannot check folder')
    expect(getFolderWorkspacePathStatusTitle(wireStatus(undefined))).toBe('Cannot check folder')
  })

  it('still titles a broken folder when a newer host sends an undeclared reason', () => {
    const title = getFolderWorkspacePathStatusTitle(wireStatus('permission-denied'))

    expect(typeof title).toBe('string')
    expect(title).not.toBe('')
  })

  // Why: Object.hasOwn coerces its key, so ['missing'] passes a hasOwn-only guard and then falls
  // straight back out of the switch — the exact P1 found in review on #15002.
  it('does not admit a non-string reason through the membership guard', () => {
    const title = getFolderWorkspacePathStatusTitle(wireStatus(['missing']))

    expect(typeof title).toBe('string')
    expect(title).not.toBe('')
    expect(title).not.toBe('Folder not found')
  })

  it('stays silent for a healthy or absent status', () => {
    expect(getFolderWorkspacePathStatusTitle(null)).toBeNull()
    expect(getFolderWorkspacePathStatusTitle({ path: '/srv/scans', exists: true })).toBeNull()
  })
})

describe('getFolderWorkspacePathStatusDescription', () => {
  it('keeps the declared reasons on their own copy', () => {
    expect(getFolderWorkspacePathStatusDescription(wireStatus('missing'))).toBe(
      'Orca cannot find /srv/scans. Remove and re-import this folder workspace.'
    )
    expect(getFolderWorkspacePathStatusDescription(wireStatus(undefined))).toBe(
      'Orca cannot verify this folder right now. Check the runtime or SSH connection and try again.'
    )
  })

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
  it('maps each main-process path error code to its own copy', () => {
    expect(getFolderWorkspacePathErrorCopy('folder_workspace_path_missing:/srv/scans')).toEqual({
      title: 'Folder not found',
      description: 'Orca cannot find /srv/scans. Remove and re-import the folder.'
    })
    expect(
      getFolderWorkspacePathErrorCopy('folder_workspace_path_not_directory:/srv/scans')?.title
    ).toBe('Path is not a folder')
    expect(
      getFolderWorkspacePathErrorCopy('folder_workspace_connection_ambiguous:/srv/scans')?.title
    ).toBe('Cannot determine connection')
    expect(
      getFolderWorkspacePathErrorCopy('folder_workspace_path_unavailable:/srv/scans')?.title
    ).toBe('Cannot check folder')
  })

  it('finds the code behind an Electron IPC prefix and keeps paths with spaces', () => {
    const copy = getFolderWorkspacePathErrorCopy(
      "Error invoking remote method 'pty:spawn': Error: folder_workspace_path_missing:/Users/me/My Project"
    )

    expect(copy?.description).toBe(
      'Orca cannot find /Users/me/My Project. Remove and re-import the folder.'
    )
  })

  it('maps the ambiguous-connection code the runtime throws without a path', () => {
    expect(
      getFolderWorkspacePathErrorCopy(
        "Error invoking remote method 'pty:spawn': Error: folder_workspace_connection_ambiguous"
      )?.title
    ).toBe('Cannot determine connection')
  })

  it('returns null for unrelated errors', () => {
    expect(getFolderWorkspacePathErrorCopy('folder_workspace_not_found')).toBeNull()
    expect(getFolderWorkspacePathErrorCopy('folder_workspace_path_missing_extra:/x')).toBeNull()
    expect(getFolderWorkspacePathErrorCopy('Failed to spawn shell')).toBeNull()
  })
})

describe('formatFolderWorkspaceCreateError', () => {
  it('uses the path copy for path codes and the raw message otherwise', () => {
    expect(
      formatFolderWorkspaceCreateError(new Error('folder_workspace_path_missing:/srv/app')).title
    ).toBe('Folder not found')
    expect(formatFolderWorkspaceCreateError(new Error('disk full'))).toEqual({
      title: 'Failed to create folder workspace',
      description: 'disk full'
    })
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
