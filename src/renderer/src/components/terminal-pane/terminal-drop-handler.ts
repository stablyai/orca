import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { isWindowsUserAgent, shellEscapePath } from './pane-helpers'
import type { PtyTransport } from './pty-transport'

type Args = {
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  worktreeId: string
  cwd: string | undefined
  data: { paths: string[]; target: string; tabId?: string }
}

/**
 * Handle a native file drop targeted at a terminal pane.
 *
 * Local worktrees: paste the local absolute path (reference-in-place; no copy
 * or IPC). SSH worktrees: upload each file into `${worktreePath}/.orca/drops`
 * and paste the remote path so the remote agent can read it. See
 * docs/terminal-drop-ssh.md.
 */
export async function handleTerminalFileDrop(args: Args): Promise<void> {
  const { manager, paneTransports, worktreeId, cwd, data } = args
  if (data.paths.length === 0) {
    return
  }
  const pane = manager.getActivePane() ?? manager.getPanes()[0]
  if (!pane) {
    return
  }
  const paneId = pane.id
  const transport = paneTransports.get(paneId)
  if (!transport) {
    return
  }

  // Why: `getConnectionId` returns `string` (SSH), `null` (local repo found),
  // or `undefined` (store not hydrated / worktree not found). Treat
  // `undefined` as an error — otherwise a drop during hydration would
  // silently paste local paths into a remote shell.
  const connectionId = getConnectionId(worktreeId)
  if (connectionId === undefined) {
    toast.error('Worktree not ready — try again in a moment.')
    return
  }
  const isRemote = connectionId !== null
  const targetShell: 'posix' | 'windows' = isRemote
    ? 'posix'
    : isWindowsUserAgent()
      ? 'windows'
      : 'posix'

  // Why: local fast path — no IPC round-trip, no toast — preserves today's
  // zero-latency drop behavior. Trailing space separates multiple paths in
  // the terminal input, matching standard drag-and-drop UX conventions.
  if (!isRemote) {
    for (const p of data.paths) {
      transport.sendInput(`${shellEscapePath(p, targetShell)} `)
    }
    pane.terminal.focus()
    return
  }

  const worktreePath = resolveWorktreePath(worktreeId, cwd)
  if (!worktreePath) {
    toast.error('Worktree path not available.')
    return
  }

  const pending = toast.loading(
    `Uploading ${data.paths.length} file${data.paths.length === 1 ? '' : 's'} to remote…`
  )
  try {
    const { resolvedPaths, skipped, failed } = await window.api.fs.resolveDroppedPathsForAgent({
      paths: data.paths,
      worktreePath,
      connectionId
    })
    // Why: pane may have unmounted during the SFTP upload (tab closed,
    // worktree switched). Re-check the transport map before writing so we
    // don't call sendInput on a torn-down PTY. Orphaned uploads are an
    // acknowledged limitation — see docs/terminal-drop-ssh.md.
    const liveTransport = paneTransports.get(paneId)
    if (liveTransport) {
      for (const p of resolvedPaths) {
        liveTransport.sendInput(`${shellEscapePath(p, targetShell)} `)
      }
      pane.terminal.focus()
    }
    if (skipped.length > 0) {
      // Why: symlink rejection is policy, not error — show as neutral
      // message. Mixed skips collapse to a single "items" count to avoid
      // enumerating every reason.
      const symlinkCount = skipped.filter((s) => s.reason === 'symlink').length
      const noun = skipped.length === 1 ? 'item' : 'items'
      toast.message(
        symlinkCount === skipped.length
          ? `Skipped ${skipped.length} symlink${skipped.length === 1 ? '' : 's'}.`
          : `Skipped ${skipped.length} ${noun}.`
      )
    }
    if (failed.length > 0) {
      const noun = failed.length === 1 ? 'file' : 'files'
      toast.error(`Failed to upload ${failed.length} ${noun}.`)
    }
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
  } finally {
    toast.dismiss(pending)
  }
}

function resolveWorktreePath(worktreeId: string, fallbackCwd: string | undefined): string | null {
  const state = useAppStore.getState()
  const allWorktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  const worktree = allWorktrees.find((w) => w.id === worktreeId)
  return worktree?.path ?? fallbackCwd ?? null
}
