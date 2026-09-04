import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  folderColorTagWriteFence,
  preserveFencedFolderColorTags
} from './folder-workspace-color-tag-fence'

const groups = [
  { id: 'group-1', executionHostId: 'local' } as unknown as ProjectGroup,
  { id: 'group-ssh', executionHostId: 'ssh:box' } as unknown as ProjectGroup
]
function folder(id: string, colorTag: string | null, groupId = 'group-1'): FolderWorkspace {
  return { id, projectGroupId: groupId, colorTag } as unknown as FolderWorkspace
}

describe('preserveFencedFolderColorTags', () => {
  // Regression: the folder catalog merged wholesale, so a listing captured before a color write
  // and merged after it restored the old color until a later refresh succeeded.
  it('keeps the current color for a listing that started before the write landed', () => {
    const { landed } = folderColorTagWriteFence.begin('f-1', 'local', undefined, undefined, {
      written: '#ef4444'
    })
    const before = Date.now() - 1
    landed()
    const merged = preserveFencedFolderColorTags(
      [folder('f-1', null)],
      [folder('f-1', '#ef4444')],
      groups,
      before
    )
    expect(merged[0]?.colorTag).toBe('#ef4444')
  })

  it('accepts the refreshed color for a listing that started after the write landed', () => {
    folderColorTagWriteFence
      .begin('f-2', 'local', undefined, undefined, { written: '#ef4444' })
      .landed()
    const merged = preserveFencedFolderColorTags(
      [folder('f-2', null)],
      [folder('f-2', '#ef4444')],
      groups,
      Date.now() + 1000
    )
    expect(merged[0]?.colorTag).toBeNull()
  })

  // Regression: the fence returned a fresh array even when it held nothing, and the catalog actions
  // read that as a changed catalog on every refetch.
  it('returns the merged array itself when nothing is held', () => {
    const merged = [folder('f-5', '#22c55e')]
    expect(preserveFencedFolderColorTags(merged, [folder('f-5', '#22c55e')], groups, 0)).toBe(
      merged
    )
    expect(preserveFencedFolderColorTags(merged, [], groups, 0)).toBe(merged)
  })

  it('leaves rows on another host and rows with an unchanged color untouched', () => {
    folderColorTagWriteFence.begin('f-3', 'local', undefined, undefined, { written: '#ef4444' })
    const merged = preserveFencedFolderColorTags(
      [folder('f-3', null, 'group-ssh'), folder('f-4', '#22c55e')],
      [folder('f-3', '#ef4444'), folder('f-4', '#22c55e')],
      groups,
      Date.now() - 1
    )
    expect(merged.map((workspace) => workspace.colorTag)).toEqual([null, '#22c55e'])
  })
})
