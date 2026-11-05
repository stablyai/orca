import { useMemo } from 'react'
import { getRelativePathInsideRoot } from '@/lib/path'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { HtmlDocPreview } from './HtmlDocPreview'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'

/** Document previews replace the whole URL pane because document state supplies chrome, history and identity. */
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
  // Resolve current ownership; persisted pages may predate pairing or SSH reconnects.
  const runtimeEnvironmentId = useAppStore((store) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(store, worktreeId)
  )
  const relativePath = useMemo(
    () => getRelativePathInsideRoot(filePath, worktreeRoot) ?? filePath,
    [filePath, worktreeRoot]
  )
  // Retained previews can sit behind terminals/editors; only the reader’s active surface may take guest focus.
  const isReaderSurface = useAppStore(
    (store) =>
      store.activeTabTypeByWorktree[worktreeId] === 'browser' &&
      store.activeBrowserTabIdByWorktree[worktreeId] === page.workspaceId
  )

  if (!docLocation) {
    return null
  }

  return (
    // Retain inactive guests, scroll position and in-flight grabs, matching URL panes.
    <div className="absolute inset-0 flex min-h-0 flex-col" hidden={!isActive}>
      <HtmlDocPreview
        isActive={isActive}
        holdsGuestFocus={isActive && isReaderSurface}
        previewId={page.id}
        browserWorkspaceId={page.workspaceId}
        filePath={filePath}
        relativePath={relativePath}
        worktreeId={worktreeId}
        runtimeEnvironmentId={runtimeEnvironmentId}
        convertedFrom={page.convertedFrom ?? null}
        convertedTo={page.convertedTo ?? null}
      />
    </div>
  )
}
