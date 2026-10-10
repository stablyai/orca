import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { HookPresenceTransition } from './agent-hook-presence-transition'
import type { AgentProcessIdentity, AgentProcessVerdict } from './agent-process-presence'

/** One probe per owner per window, however many guest events arrive. */
export const OWNER_PROBE_COOLDOWN_MS = 10_000
/** How long a held guest event may still take the pane once its owner is found gone. */
export const HELD_GUEST_WINDOW_MS = 30_000

type OwnerProbe = { owner: string; startedAt: number }
type HeldGuest = { owner: string; heldAt: number; reapply: () => void }

function ownerKey(owner: AgentProcessIdentity): string {
  return `${owner.platform}:${owner.pid}:${owner.startTime}`
}

/** A host's one owner-check surface: applies presence transitions, checks doubted owners without
 *  making ingest wait, and hands a released pane to the guest held behind that same owner. */
export class PaneOwnerProbes {
  private readonly probes = new Map<string, OwnerProbe>()
  private readonly held = new Map<string, HeldGuest>()

  constructor(
    private readonly deps: {
      /** The pane's current owner process, if the host can check it. */
      ownerOf: (paneKey: string) => AgentProcessIdentity | undefined
      /** The host's own check; resolves `exited` only once it released the pane. */
      checkOwner: (paneKey: string) => Promise<AgentProcessVerdict | null>
      now?: () => number
    }
  ) {}

  admit<T>(
    paneKey: string,
    transition: HookPresenceTransition,
    host: { write: (event: AgentHookEventPayload) => T; reapply: () => void }
  ): T | undefined {
    if (transition.kind === 'skip') {
      if (transition.probe) {
        // Why: one slot per pane; the latest guest event is what a released pane should show.
        const owner = ownerKey(transition.probe)
        this.held.set(paneKey, { owner, heldAt: this.now(), reapply: host.reapply })
        this.probe(paneKey, transition.probe)
      }
      return undefined
    }
    const written = host.write(transition.event)
    // Why after the write: the host's check is bound to the row it reads, so it must read this one.
    if (transition.probe) {
      this.probe(paneKey, transition.probe)
    }
    return written
  }

  /** Rate-limited check of an owner another signal cast doubt on. */
  probe(paneKey: string, owner: AgentProcessIdentity): void {
    const now = this.now()
    this.sweep(now)
    const key = ownerKey(owner)
    if (this.probes.get(paneKey)?.owner === key) {
      return
    }
    this.probes.set(paneKey, { owner: key, startedAt: now })
    void this.check(paneKey)
  }

  /** Checks the pane's owner now; every host caller that can release a pane goes through here. */
  check(paneKey: string): Promise<AgentProcessVerdict | null> {
    const owner = this.deps.ownerOf(paneKey)
    return this.deps.checkOwner(paneKey).then((verdict) => {
      const held = this.held.get(paneKey)
      if (verdict === 'exited' && owner && held?.owner === ownerKey(owner)) {
        this.held.delete(paneKey)
        // Why: replay re-classifies against the released row, so it only lands if it may claim it.
        if (this.now() - held.heldAt <= HELD_GUEST_WINDOW_MS) {
          held.reapply()
        }
      }
      return verdict
    })
  }

  private sweep(now: number): void {
    for (const [paneKey, held] of this.held) {
      if (now - held.heldAt > HELD_GUEST_WINDOW_MS) {
        this.held.delete(paneKey)
      }
    }
    for (const [paneKey, probe] of this.probes) {
      if (now - probe.startedAt >= OWNER_PROBE_COOLDOWN_MS) {
        this.probes.delete(paneKey)
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
