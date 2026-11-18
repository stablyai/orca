import { useAppStore } from '@/store/index'
import type { DirEntry } from '../../../../../shared/file-listing/directory-entry'
import {
  dirEntryPageAfter,
  type DirEntryCursor,
  type DirEntryPage
} from '../../../../../shared/file-listing/file-dir-page'
import { sortDirEntries } from '../../../../../shared/file-listing/file-name-sort'
import { FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY } from '../../../../../shared/file-access/files-runtime-capabilities'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeFileOperationArgs } from '../runtime-file-client-types'
import { getRemoteFileArgs } from '../runtime-file-routing'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { readRuntimeDirectory } from './runtime-directory-read'

function hostServesDirPages(environmentId: string): boolean {
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  return (
    !isRuntimeHostContactRevoked(entry) &&
    lastVerifiedRuntimeStatus(entry)?.capabilities?.includes(
      FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY
    ) === true
  )
}

// Older hosts may return lexical order; the cursor needs the listing order.
function wholeFolderAfter(entries: DirEntry[], after: DirEntryCursor | undefined): DirEntryPage {
  const sorted = sortDirEntries([...entries])
  return dirEntryPageAfter(sorted, after, sorted.length)
}

/** True where `dirPath` is on a remote server that serves folders in pages. */
export function runtimeDirectoryPagesSupported(
  context: RuntimeFileOperationArgs,
  dirPath: string
): boolean {
  const remoteArgs = getRemoteFileArgs(context, dirPath)
  return remoteArgs !== null && hostServesDirPages(remoteArgs.target.environmentId)
}

/**
 * One page of a remote server's folder. Where the folder is local, over SSH, or on a host too old
 * to page, it returns every entry after `after`, with `hasMore` false.
 */
export async function readRuntimeDirectoryPage(
  context: RuntimeFileOperationArgs,
  dirPath: string,
  page: { after?: DirEntryCursor; limit: number },
  options: { followSymlinks?: boolean; wakeWslDistro?: boolean } = {}
): Promise<DirEntryPage> {
  const remoteArgs = getRemoteFileArgs(context, dirPath)
  if (!remoteArgs || !hostServesDirPages(remoteArgs.target.environmentId)) {
    return wholeFolderAfter(await readRuntimeDirectory(context, dirPath, options), page.after)
  }
  const result = await callRuntimeRpc<DirEntryPage | DirEntry[]>(
    remoteArgs.target,
    'files.readDir',
    {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath,
      ...(options.followSymlinks === undefined ? {} : { followSymlinks: options.followSymlinks }),
      ...(page.after ? { after: page.after } : {}),
      limit: page.limit
    },
    { timeoutMs: 15_000 }
  )
  // Why: a host replaced by an older build since its status was read ignores the page fields.
  return Array.isArray(result) ? wholeFolderAfter(result, page.after) : result
}
