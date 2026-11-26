// Who can ask › Add: what live username checks said about who holds which login, for one picker
// open. Kept apart from what the picker paints, so an answer that settles after its query moved
// on, before a late list, or in another context's session still counts for every pick.

type Holder = { id: string; name: string }
type Observation = { seq: number; login: string; holder: Holder | null }

/** Where a pick stands against what the checks said: `current` (the newest check naming its id
 *  says `name`, and no newer check of that login says otherwise), `contradicted` (its login now
 *  belongs to someone else or no one, and no newer check names its id again), or `unknown`
 *  (nothing has said anything about it). */
export type WhoCanAskIdentity =
  | { status: 'current'; name: string }
  | { status: 'contradicted' }
  | { status: 'unknown' }

const key = (login: string): string => login.toLowerCase()

/** Ordered by when each check was asked, not when it answered: an older check that lands late
 *  never overrides a newer one about the same login or id. A contradiction lasts until a newer
 *  check names that id again: a later miss on the login proves nothing about who holds it. */
export class WhoCanAskIdentityLedger {
  private issued = 0
  private readonly pendingChecks = new Map<number, string>()
  // Every settled check of each login, and the newest check each id was seen in.
  private readonly byLogin = new Map<string, Observation[]>()
  private readonly byId = new Map<string, Observation>()
  private readonly listeners = new Set<() => void>()
  private readonly settleListeners = new Set<() => void>()
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
      this.byLogin.set(observation.login, [
        ...(this.byLogin.get(observation.login) ?? []),
        observation
      ])
      if (holder && (this.byId.get(holder.id)?.seq ?? 0) < seq) {
        this.byId.set(holder.id, observation)
      }
    }
    this.changed()
    for (const listener of this.settleListeners) {
      listener()
    }
  }

  /** Logins whose check is still out (lowercase). */
  pending(): string[] {
    return [...new Set(this.pendingChecks.values())]
  }

  /** Every login a check has seen `id` hold (lowercase). */
  aliases(id: string): string[] {
    const logins: string[] = []
    for (const [login, observations] of this.byLogin) {
      if (observations.some((observation) => observation.holder?.id === id)) {
        logins.push(login)
      }
    }
    return logins
  }

  identity(id: string, login: string): WhoCanAskIdentity {
    const seen = this.byId.get(id)
    if (seen?.holder) {
      // Theirs unless a newer check of that login found someone else or no one. Then their
      // current login is unknown: an older alias is not theirs again just because of that.
      const later = (this.byLogin.get(seen.login) ?? []).some(
        (observation) => observation.seq > seen.seq
      )
      return later ? { status: 'contradicted' } : { status: 'current', name: seen.holder.name }
    }
    // Never seen by a check: a listed login is theirs unless any check gave it to someone else.
    const given = (this.byLogin.get(key(login)) ?? []).some(
      (observation) => observation.holder !== null && observation.holder.id !== id
    )
    return given ? { status: 'contradicted' } : { status: 'unknown' }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Told each time a check settles (not when one is asked). */
  onSettle = (listener: () => void): (() => void) => {
    this.settleListeners.add(listener)
    return () => this.settleListeners.delete(listener)
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
