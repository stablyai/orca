import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { diffReviewKey, diffReviewScope } from '@/lib/editor/diff-reviewed-files'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { readAppState } from '@/store'
import { joinPath } from '@/lib/path'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { getFileConnectionOwnerFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import {
  editorFileChildRoute,
  editorFileChildAuthority
} from '@/lib/editor/file-operations/editor-file-child-owner'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/workspace/ownership/worktree-operation-generation'
import { getExpectedSshConnectionGeneration } from '@/lib/editor/file-operations/editor-file-operation-provenance'

export function combinedDiffReviewIdentity(
  file: OpenFile,
  section: Pick<DiffSection, 'path' | 'area'>
) {
  const state = readAppState()
  const filePath = joinPath(file.filePath, section.path)
  const child = getFileConnectionOwnerFromState(state, file.worktreeId, filePath)?.repo
  const route = editorFileChildRoute(child)
  const authority = editorFileChildAuthority(child)
  const context = getEditorFileReadContext(
    state,
    {
      ...file,
      filePath,
      ...(route && child
        ? {
            operationProvenance: {
              generation: captureWorktreeOperationGenerationSnapshot(route, authority),
              ownershipProjection: 'explicit' as const,
              childRepo: { id: child.id, path: child.path },
              expectedSshConnectionGeneration: getExpectedSshConnectionGeneration(
                state,
                route,
                authority
              )
            }
          }
        : {})
    },
    file.filePath
  )
  const diffSource =
    section.area !== undefined
      ? section.area === 'staged'
        ? 'staged'
        : 'unstaged'
      : file.diffSource === 'combined-commit'
        ? 'commit'
        : 'branch'
  return {
    key: diffReviewKey(context, section.path, diffReviewScope({ ...file, diffSource }))
  }
}
