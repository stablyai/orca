import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { editorArtifactSourceKey } from '@/components/editor/editor-artifact-upload'
import { buildDocPreviewGrantRequest } from '@/lib/doc-preview-grants'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { fileArtifactSourceKey } from '@/lib/file-artifact-source-key'
import { makeRepo, makeWorktree } from '@/components/worktree-jump-palette-test-fixtures'
import { docPreviewGrantFileOwner } from './doc-preview-artifact-share'

const WORKTREE_ID = 'repo-1::/srv/repo'
const FILE_PATH = '/srv/repo/reports/latency.html'

function seed(repo: Partial<Repo>, worktree: Partial<Worktree>): void {
  useAppStore.setState({
    repos: [{ ...makeRepo(), path: '/srv/repo', ...repo }],
    worktreesByRepo: {
      'repo-1': [makeWorktree(WORKTREE_ID, 'repo', { path: '/srv/repo', ...worktree })]
    },
    detectedWorktreesByRepo: {}
  })
}

function editorKey(): string {
  const state = useAppStore.getState()
  return editorArtifactSourceKey({
    id: FILE_PATH,
    filePath: FILE_PATH,
    relativePath: 'reports/latency.html',
    worktreeId: WORKTREE_ID,
    language: 'html',
    isDirty: false,
    mode: 'edit',
    operationProvenance: captureEditorFileOperationProvenance(state, WORKTREE_ID, undefined, false)
  })
}

function previewKey(): string {
  const location = buildDocPreviewGrantRequest(useAppStore.getState(), WORKTREE_ID, FILE_PATH)
  if (!location) {
    throw new Error('no grant location')
  }
  return fileArtifactSourceKey(docPreviewGrantFileOwner(location.owner), FILE_PATH)
}

describe('preview Share key matches the editor key', () => {
  // The grant mints on the SSH target the workspace row names, so both surfaces key it as SSH.
  it('for an SSH workspace a paired server proxies', () => {
    seed(
      { connectionId: 'hub-target', executionHostId: 'runtime:hub-a' },
      { hostId: 'ssh:hub-target', runtimeOwnerEnvironmentId: 'hub-a' }
    )
    expect(previewKey()).toBe(editorKey())
  })

  it('for a mixed-version SSH publication from a paired server', () => {
    seed(
      { connectionId: 'hub-target', executionHostId: 'runtime:hub-a' },
      { hostId: 'ssh:hub-target' }
    )
    expect(previewKey()).toBe(editorKey())
  })

  it('for a plain paired workspace', () => {
    seed({ executionHostId: 'runtime:hub-a' }, { hostId: 'runtime:hub-a' })
    expect(previewKey()).toBe(editorKey())
  })
})
