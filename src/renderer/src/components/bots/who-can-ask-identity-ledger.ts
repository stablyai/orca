// Who can ask › Add: what live username checks said about who holds which login, for one picker
// open. Kept apart from what the picker paints, so an answer that settles after its query moved
// on, before a late list, or in another context's session still counts for every pick.

type Holder = { id: string; name: string }
type Observation = { seq: number; login: string; holder: Holder | null }

/** Where a pick stands against what the checks said: `current` (its id was seen under `name`, the
 *  newest word on that login), `contradicted` (a newer check gave its login to another id), or
 *  `unknown` (nothing says otherwise). */
export type WhoCanAskIdentity =
  | { status: 'current'; name: string }
  | { status: 'contradicted' }
  | { status: 'unknown' }

const key = (login: string): string => login.toLowerCase()

/** Ordered by when each check was asked, not when it answered: an older check that lands late
 *  never overrides a newer one about the same login or id. */
export class WhoCanAskIdentityLedger {
  private issued = 0
  private readonly pendingChecks = new Map<number, string>()
  // The newest settled check of each login, and the newest one each id was seen in.
  private readonly holders = new Map<string, Observation>()
  private readonly names = new Map<string, Observation>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  /** A check of `login` was asked; its answer goes to settle() with the returned number. */
  issue(login: string): number {
    this.issued += 1
    this.pendingChecks.set(this.issued, key(login))
    this.changed()
    return this.issued
  }

  /** `members`: who the check found holding `login` (none: nobody); null when the check failed. */
  settle(seq: number, login: string, members: readonly Holder[] | null): void {
    this.pendingChecks.delete(seq)
    if (members !== null) {
      const holder = members.find((member) => key(member.name) === key(login)) ?? null
      const observation: Observation = { seq, login: key(login), holder }
      if ((this.holders.get(observation.login)?.seq ?? 0) < seq) {
        this.holders.set(observation.login, observation)
      }
      if (holder && (this.names.get(holder.id)?.seq ?? 0) < seq) {
        this.names.set(holder.id, observation)
      }
    }
    this.changed()
  }

  /** Logins whose check is still out (lowercase). */
  pending(): string[] {
    return [...new Set(this.pendingChecks.values())]
  }

  identity(id: string, login: string): WhoCanAskIdentity {
    const seen = this.names.get(id)
    if (seen?.holder) {
      const since = this.holders.get(seen.login)
      // Still theirs unless a newer check gave that login to someone else.
      if (!since || since.seq <= seen.seq || since.holder?.id === id) {
        return { status: 'current', name: seen.holder.name }
      }
    }
    const holder = this.holders.get(key(login))?.holder
    return holder && holder.id !== id ? { status: 'contradicted' } : { status: 'unknown' }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Changes whenever a check is asked or settles. */
  version = (): number => this.revision

  private changed(): void {
    this.revision += 1
    for (const listener of this.listeners) {
      listener()
    }
  }
}
