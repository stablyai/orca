/**
 * Asks a remote pane's own shell for its pid, through the production write path.
 *
 * Why not read it from app state: a pane id, a leaf id and a PTY id can all
 * match while a different process runs underneath. The shell answers on the
 * container's filesystem, so the pid is observed where the process actually
 * lives — and a pane that no longer reaches its shell cannot answer at all.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { sendToTerminal } from './terminal'
import {
  execDockerSshRelayTargetCommand,
  shellQuote,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

function readRemoteFile(target: DockerSshRelayTarget, remotePath: string): string | null {
  try {
    return execDockerSshRelayTargetCommand(target, `cat ${shellQuote(remotePath)}`)
  } catch {
    return null
  }
}

/**
 * `probePath` must be unique per probe: a stale file from an earlier phase would
 * answer for a shell that is no longer there.
 */
export async function readRemoteShellPid(
  page: Page,
  target: DockerSshRelayTarget,
  args: { ptyId: string; probePath: string; timeoutMs?: number }
): Promise<number> {
  if (readRemoteFile(target, args.probePath) !== null) {
    throw new Error(`Remote shell pid probe path already exists: ${args.probePath}`)
  }
  // Write-then-rename: the redirect creates the file before printf fills it, and
  // a poll that caught it empty would read pid 0.
  await sendToTerminal(
    page,
    args.ptyId,
    `printf '%s\\n' "$$" > ${args.probePath}.part && mv ${args.probePath}.part ${args.probePath}\r`
  )
  let pid: number | null = null
  await expect
    .poll(
      () => {
        const raw = readRemoteFile(target, args.probePath)
        const parsed = raw === null ? Number.NaN : Number(raw.trim())
        pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null
        return pid
      },
      {
        timeout: args.timeoutMs ?? 60_000,
        message: `Remote pane ${args.ptyId} never reported its shell pid to ${args.probePath}`
      }
    )
    .not.toBeNull()
  if (pid === null) {
    throw new Error(`Remote pane ${args.ptyId} reported no shell pid`)
  }
  return pid
}
