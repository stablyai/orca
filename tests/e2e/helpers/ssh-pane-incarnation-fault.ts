/**
 * Induce the one state the unreachable-pane affordance needs: the SSH target CONNECTED while
 * exactly ONE pane's `pty.attach` fails with an error that does not prove the shell exited.
 *
 * Why this exists: host-side faults cannot produce it. Stalling the relay takes the whole
 * connection down with it, so the client shows the connection-level overlay and the pane never
 * even attempts the attach that has to fail. That is why the decisive cases sat at `fixme`.
 *
 * How this does produce it: the relay refuses an attach whose `expectedIncarnationId` names a
 * different shell, with `PTY "<id>" identity mismatch` — per-pty, connection untouched, and
 * explicitly never grounds a respawn. Rewriting the pane's RECORDED incarnation while the app is
 * closed makes the next attach carry an expectation the host cannot match, so the relay refuses
 * that one pane and nothing else.
 *
 * This is the same shape as the real failure it stands in for: a replaced relay reissues ids from
 * `pty-1`, so the shell now answering to a pane's id is not the shell the pane recorded.
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** Not a UUID the host could ever mint, so a match would mean the fence did not run. */
export const FOREIGN_PTY_INCARNATION = 'incarnation-from-a-relay-that-is-not-this-one'

type MutablePersistedState = {
  workspaceSession?: {
    terminalPtyIncarnationsByPaneKey?: Record<string, string>
  }
  sshRemotePtyLeases?: { targetId: string; ptyId: string; incarnationId?: string }[]
}

/**
 * Point the pane's recorded shell identity at a shell the host does not have.
 *
 * Both homes are rewritten because the two attach routes read different ones: the pane-driven
 * restore sends the binding's incarnation, the relay-session reconnect sends the lease's. Leaving
 * either untouched would let that route attach cleanly and the pane would never reach the card.
 *
 * Call only while the app is closed — the running app holds this state in memory and would
 * overwrite the file on its next flush.
 */
export function recordForeignShellIdentityForPane(
  stateFile: string,
  paneKey: string,
  targetId: string
): {
  paneIncarnationBefore: string | undefined
  leasesRewritten: number
  /** Everything the state file actually held, so a miss reports why instead of just failing. */
  diagnostics: string
} {
  const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as MutablePersistedState
  const incarnations = (state.workspaceSession ??= {}).terminalPtyIncarnationsByPaneKey ?? {}
  const paneIncarnationBefore = incarnations[paneKey]
  incarnations[paneKey] = FOREIGN_PTY_INCARNATION
  state.workspaceSession.terminalPtyIncarnationsByPaneKey = incarnations

  let leasesRewritten = 0
  for (const lease of state.sshRemotePtyLeases ?? []) {
    if (lease.targetId === targetId) {
      lease.incarnationId = FOREIGN_PTY_INCARNATION
      leasesRewritten += 1
    }
  }

  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  const knownPaneKeys = Object.keys(incarnations)
  const leases = (state.sshRemotePtyLeases ?? []).map(
    (lease) => `${lease.targetId}/${lease.ptyId}${lease.incarnationId ? '@known' : '@none'}`
  )
  return {
    paneIncarnationBefore,
    leasesRewritten,
    diagnostics: `paneKey=${paneKey} incarnationKeys=[${knownPaneKeys.join(', ')}] leases=[${leases.join(', ')}]`
  }
}
