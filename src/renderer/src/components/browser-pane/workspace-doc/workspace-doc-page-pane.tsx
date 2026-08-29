import { useMemo } from 'react'
import { getRelativePathInsideRoot } from '@/lib/path'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { HtmlDocPreview } from './HtmlDocPreview'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'

/**
 * The pane for a browser page located by a workspace document. Everything a URL page's chrome does
 * — address bar, history, favicon — is answered by the document itself, so this stands in for the
 * whole of `BrowserPagePane` rather than wrapping it.
 */
export function WorkspaceDocPagePane({
  page,
  isActive
}: {
  page: BrowserPage
  isActive: boolean
}): React.JSX.Element | null {
  const docLocation = page.docLocation ?? null
  const worktreeId = docLocation?.worktreeId ?? page.worktreeId
  const filePath = docLocation?.filePath ?? ''
  const worktreeRoot = useAppStore((store) => store.getKnownWorktreeById(worktreeId)?.path ?? null)
  // Why resolved here rather than stored on the page: ownership moves. A page persisted before a
  // pairing or an SSH reconnect would otherwise route its document actions at yesterday's host.
  const runtimeEnvironmentId = useAppStore(
    (store) => getRuntimeEnvironmentIdForWorktree(store, worktreeId) ?? null
  )
  const relativePath = useMemo(
    () => getRelativePathInsideRoot(filePath, worktreeRoot) ?? filePath,
    [filePath, worktreeRoot]
  )
  // Why the reader's whole surface and not just this page's activity: a preview keeps its pane
  // mounted behind a terminal or an editor, and focusing its guest from there would take the
  // keyboard away from what the reader is actually in.
  const isReaderSurface = useAppStore(
    (store) =>
      store.activeTabTypeByWorktree[worktreeId] === 'browser' &&
      store.activeBrowserTabIdByWorktree[worktreeId] === page.workspaceId
  )

  if (!docLocation) {
    return null
  }

  return (
    // Why hidden and not unmounted: an inactive page keeps its guest, its scroll position and any
    // grab in flight, exactly as a URL page's pane does.
    <div className="absolute inset-0 flex min-h-0 flex-col" hidden={!isActive}>
      <HtmlDocPreview
        holdsGuestFocus={isActive && isReaderSurface}
        previewId={page.id}
        filePath={filePath}
        relativePath={relativePath}
        worktreeId={worktreeId}
        runtimeEnvironmentId={runtimeEnvironmentId}
      />
    </div>
  )
}
