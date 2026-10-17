/**
 * Panes whose agent status this renderer owns from the PTY byte stream.
 *
 * Remote-runtime panes have two writers for one store key: the client's own
 * OSC pipeline (pty-connection `shouldOwnAgentStatusInRenderer`) and the
 * mirrored host `session.tabs` snapshot. Without a fence they overwrite each
 * other on every publication and the tab flaps between "working + generated
 * title" and "done + Terminal". Registration marks the claim (decided once at
 * transport creation); the first byte-derived write proves it, so a mirrored
 * pane that never produced status keeps ceding to the host.
 */
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'

type RendererOwnedAgentStatusPane = {
  environmentId: string
  hasClientWrite: boolean
  /** When the pane's mount gave the claim back, or null while it is held. */
  releasedAt: number | null
}

const panesByPaneKey = new Map<string, RendererOwnedAgentStatusPane>()

/** A released claim is only evidence for as long as the row it wrote can live. */
function forgetExpiredReleases(now: number): void {
  for (const [paneKey, pane] of panesByPaneKey) {
    if (pane.releasedAt !== null && now - pane.releasedAt > AGENT_STATUS_STALE_AFTER_MS) {
      panesByPaneKey.delete(paneKey)
    }
  }
}

/** Claims the pane and returns its release; call the release on teardown. */
export function registerRendererOwnedAgentStatusPane(
  paneKey: string,
  environmentId: string
): () => void {
  const existing = panesByPaneKey.get(paneKey)
  // Why: a remount re-registers the same pane; keep the earned claim unless the
  // pane moved to another runtime environment (then its bytes are a new stream).
  const entry: RendererOwnedAgentStatusPane = {
    environmentId,
    hasClientWrite: existing?.environmentId === environmentId && existing.hasClientWrite,
    releasedAt: null
  }
  panesByPaneKey.set(paneKey, entry)
  forgetExpiredReleases(Date.now())
  // Why identity-checked: a replacement mount registers before the superseded
  // pane's dispose runs, and paneKey is `${tabId}:${leafId}` — shared across that
  // handoff. An unconditional delete would strip the live pane's claim for good,
  // since markRendererOwnedAgentStatusWrite never recreates a missing entry.
  return () => {
    if (panesByPaneKey.get(paneKey) !== entry) {
      return
    }
    if (!entry.hasClientWrite) {
      panesByPaneKey.delete(paneKey)
      return
    }
    // Why kept, not deleted: the unmount cedes authority to the host, but the
    // fact that this renderer's bytes wrote the row outlives the mount. The
    // mirror needs it to tell "the host never had status for this pane" from
    // "the host removed the status it had" (#22445). The next registration
    // sweeps it once the row it vouches for could no longer be live.
    entry.releasedAt = Date.now()
  }
}

export function markRendererOwnedAgentStatusWrite(paneKey: string): void {
  const existing = panesByPaneKey.get(paneKey)
  if (!existing || existing.hasClientWrite) {
    return
  }
  existing.hasClientWrite = true
}

/** True once this renderer both claimed the pane and actually wrote its status. */
export function isClientAuthoritativeAgentStatusPane(paneKey: string): boolean {
  const pane = panesByPaneKey.get(paneKey)
  return pane?.hasClientWrite === true && pane.releasedAt === null
}

/**
 * True for a pane this renderer wrote from bytes and has since unmounted. The
 * host publishes no status for such a pane, so its silence says nothing about
 * the agent — unlike a pane the host itself minted status for.
 */
export function isReleasedClientWrittenAgentStatusPane(paneKey: string, now: number): boolean {
  const pane = panesByPaneKey.get(paneKey)
  return (
    pane?.hasClientWrite === true &&
    pane.releasedAt !== null &&
    now - pane.releasedAt <= AGENT_STATUS_STALE_AFTER_MS
  )
}

export function _getRendererOwnedAgentStatusPaneCountForTest(): number {
  return panesByPaneKey.size
}

export function resetRendererOwnedAgentStatusPanesForTests(): void {
  panesByPaneKey.clear()
}
