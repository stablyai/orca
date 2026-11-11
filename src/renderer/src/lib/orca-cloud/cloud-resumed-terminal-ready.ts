// RA-11 resume race: a cloud Restart reconnects the pane only once the host lists the resumed
// terminal live in the pane's own tab and leaf.
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { toHostSessionTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'

// The ensured terminal shows up in the host's inventory within a second or two of the ensure.
const RESUMED_READY_WAIT_MS = 15_000
const RESUMED_READY_POLL_MS = 300

/**
 * RA-11 resume race: wait until the host lists exactly the ensured terminal `handle`, live, in the
 * pane's own host tab and leaf. Only then may the pane reconnect: its activation reuses a ready leaf,
 * and a leaf that is not ready yet is woken with its ORIGINAL launch (the resume is then lost).
 * A turn-less `--resume` exits to a shell but its PTY stays live, so it still lists. Throws when the
 * terminal never shows, so the restart fails visibly instead of reconnecting into the race.
 */
export async function waitForResumedTerminalReady(args: {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
  handle: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<void> {
  const environmentId = parseRemoteRuntimePtyId(args.ptyId)?.environmentId
  if (!environmentId) {
    throw new Error('restart_remote_pane_unowned')
  }
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = args.now ?? Date.now
  const hostTabId = toHostSessionTabId(args.tabId)
  const deadline = now() + RESUMED_READY_WAIT_MS
  while (now() < deadline) {
    const listed = await callRuntimeRpc<{
      terminals?: {
        handle?: string
        tabId?: string
        leafId?: string
        connected?: boolean
        verdict?: string
      }[]
    }>(
      { kind: 'environment', environmentId },
      'terminal.list',
      {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        handles: [args.handle],
        includePreview: false,
        includeVisualLayouts: false
      },
      { timeoutMs: 5_000 }
    ).catch(() => null)
    const ready = (listed?.terminals ?? []).some(
      (terminal) =>
        terminal.handle === args.handle &&
        terminal.tabId === hostTabId &&
        terminal.leafId === args.leafId &&
        terminal.connected !== false &&
        terminal.verdict !== 'dead'
    )
    if (ready) {
      return
    }
    await sleep(RESUMED_READY_POLL_MS)
  }
  throw new Error('restart_resume_not_ready')
}
