import type { DocPreviewGrantRequest } from '../../../preload/api/doc-preview-api'
import { basename, dirname, getRelativePathInsideRoot } from '@/lib/path'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { AppState } from '@/store/types'

export type DocPreviewGrantHandle = { grantId: string; url: string }

/**
 * Grants are keyed by preview tab id, never by effect mount: React StrictMode
 * double-invokes mount effects in dev, and a mount-scoped grant would be revoked
 * out from under the surviving webview. Release is driven by tab close instead.
 */
const grantsByPreviewId = new Map<string, Promise<DocPreviewGrantHandle>>()

/** The page is filled in by `ensureDocPreviewGrant`, so the grant and its key name one surface. */
export type DocPreviewGrantLocation = Omit<DocPreviewGrantRequest, 'browserPageId'>

export function buildDocPreviewGrantRequest(
  state: AppState,
  worktreeId: string,
  filePath: string
): DocPreviewGrantLocation | null {
  const worktreeRoot = state.getKnownWorktreeById(worktreeId)?.path ?? null
  const worktreeRelativePath = getRelativePathInsideRoot(filePath, worktreeRoot)
  const root = dirname(filePath)
  const requestBase = worktreeRoot && worktreeRelativePath ? worktreeRoot : root
  const entryRelativePath = worktreeRelativePath ?? basename(filePath)
  if (!requestBase || !root || !entryRelativePath) {
    return null
  }
  const connectionId = getConnectionIdForFileFromState(state, worktreeId, filePath)
  if (connectionId) {
    // Outside a workspace there is no broader request base: the document directory bounds
    // resolution, and main starts such a grant at the entry file alone — an out-of-workspace
    // directory is often a home directory, which is where secrets live.
    return { owner: { kind: 'ssh', connectionId }, requestBase, root, entryRelativePath }
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!environmentId || !worktreeRoot || !worktreeRelativePath) {
    return null
  }
  return {
    owner: {
      kind: 'runtime',
      environmentId,
      worktreeSelector: toRuntimeWorktreeSelector(worktreeId),
      worktreeRoot
    },
    requestBase,
    root,
    entryRelativePath
  }
}

export function ensureDocPreviewGrant(
  previewId: string,
  location: DocPreviewGrantLocation
): Promise<DocPreviewGrantHandle> {
  const existing = grantsByPreviewId.get(previewId)
  if (existing) {
    return existing
  }
  const pending: Promise<DocPreviewGrantHandle> = window.api.docPreview
    .mintGrant({ ...location, browserPageId: previewId })
    .catch((error: unknown) => {
      // Why the identity check: a release and a fresh ensure can both land before this rejects, and
      // an unconditional delete would evict the newer entry, leaving its grant unrevokable.
      if (grantsByPreviewId.get(previewId) === pending) {
        grantsByPreviewId.delete(previewId)
      }
      throw error
    })
  grantsByPreviewId.set(previewId, pending)
  return pending
}

export function releaseDocPreviewGrant(previewId: string): void {
  const pending = grantsByPreviewId.get(previewId)
  if (!pending) {
    return
  }
  grantsByPreviewId.delete(previewId)
  void pending.then((handle) => window.api.docPreview.revokeGrant(handle.grantId)).catch(() => {})
}
