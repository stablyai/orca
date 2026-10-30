import type { DocPreviewGrantRequest } from '../../../preload/api/doc-preview-api'
import { basename, dirname, getRelativePathInsideRoot } from '@/lib/path'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { chatScratchFileAddress } from '@/runtime/runtime-chat-scratch-file-address'
import type { AppState } from '@/store/types'

/** `location` is what the grant was minted for, so its readers and its share key stay on that host. */
export type DocPreviewGrantHandle = {
  grantId: string
  url: string
  location: DocPreviewGrantLocation
}

/** Key by tab ID and release on close; StrictMode mount replay would revoke a mount-scoped grant beneath the surviving webview. */
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
    // Outside workspaces, resolve only within the document directory and initially grant only its entry file; broader roots may expose home-directory secrets.
    return { owner: { kind: 'ssh', connectionId }, requestBase, root, entryRelativePath }
  }
  // Why: a twin names no server to mint against, so it gets no grant.
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  // Outside the workspace, a chat's scratch folder stands in for it: its host serves it as a root.
  const base =
    worktreeRoot && worktreeRelativePath
      ? {
          root: worktreeRoot,
          worktreeSelector: toRuntimeWorktreeSelector(worktreeId),
          relativePath: worktreeRelativePath
        }
      : chatScratchFileAddress(filePath)
  if (!environmentId || !base) {
    return null
  }
  return {
    owner: {
      kind: 'runtime',
      environmentId,
      worktreeSelector: base.worktreeSelector,
      worktreeRoot: base.root
    },
    requestBase: base.root,
    root,
    entryRelativePath: base.relativePath
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
    .then((minted) => ({ ...minted, location }))
    .catch((error: unknown) => {
      // Delete only this entry: release/reopen may install a newer grant before rejection, and evicting it would prevent revocation.
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
