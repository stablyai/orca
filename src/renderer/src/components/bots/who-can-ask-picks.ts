// Who can ask › Add: the picks as they stand now, and which of them a check still out could
// change, so Add never hands the confirmation someone a pending check might show to be another.
import type { BotMember } from '../../../../shared/bot-types'
import type { WhoCanAskIdentityLedger } from './who-can-ask-identity-ledger'

/** Ticked people still eligible, under their newest confirmed login: anyone since listed, linked
 *  as the owner, or whose login a newer check gave to another account is left out of the count,
 *  the cap and the grant. Everyone else stays picked. */
export function currentPicks(
  ticked: readonly BotMember[],
  eligible: (id: string) => boolean,
  ledger: WhoCanAskIdentityLedger
): BotMember[] {
  return ticked.flatMap((member) => {
    if (!eligible(member.id)) {
      return []
    }
    const known = ledger.identity(member.id, member.name || member.id)
    return known.status === 'contradicted'
      ? []
      : known.status === 'current' && known.name !== member.name
        ? [{ ...member, name: known.name }]
        : [member]
  })
}

/** Found rows as the checks left them: a login a newer check confirmed outranks the row's older
 *  one, and a row whose login it gave to someone else is hidden. */
export function currentRows<T extends { id: string; name: string }>(
  rows: readonly T[],
  ledger: WhoCanAskIdentityLedger
): T[] {
  return rows.flatMap((row) => {
    const known = ledger.identity(row.id, row.name)
    return known.status === 'contradicted'
      ? []
      : known.status === 'current' && known.name !== row.name
        ? [{ ...row, name: known.name }]
        : [row]
  })
}

/** Picks a username check still out could re-identify: its login is one they have been known by
 *  (as ticked, as now shown, or as any check saw them), or it matches one of those or their real
 *  name, as ticked or as a list later gave it (it may find their id under a new login). Others can
 *  be added meanwhile. */
export function heldPicks(
  picks: readonly BotMember[],
  ticked: readonly BotMember[],
  realNames: Readonly<Record<string, string>>,
  ledger: WhoCanAskIdentityLedger
): BotMember[] {
  const pending = ledger.pending()
  if (pending.length === 0) {
    return []
  }
  return picks.filter((member) => {
    const known = [
      member.name || member.id,
      ticked.find((entry) => entry.id === member.id)?.name ?? '',
      realNames[member.id] ?? '',
      ledger.realName(member.id) ?? '',
      ...ledger.aliases(member.id)
    ].map((name) => name.toLowerCase())
    return pending.some((login) => known.some((name) => name !== '' && name.includes(login)))
  })
}

/** The picks handed to Add, still tied to the checks this picker open had already asked: those
 *  keep settling after the picker closes, so the grant can see what they found before writing.
 *  Reads are synchronous, so the grant's last decision and its hand-off to the writer are one
 *  step; only `settled` waits, and only on checks already out. */
export type WhoCanAskProposal = {
  /** Whether a check still out could change one of `people`. */
  held: (people: readonly BotMember[]) => boolean
  /** `people` as the checks leave them now: renamed, or dropped when shown to be someone else. */
  current: (people: readonly BotMember[]) => BotMember[]
  /** Resolves when the next check settles (no new check is asked; each settles on its own
   *  bounds). */
  settled: () => Promise<void>
}

export function whoCanAskProposal(
  ticked: readonly BotMember[],
  realNames: Readonly<Record<string, string>>,
  ledger: WhoCanAskIdentityLedger
): WhoCanAskProposal {
  const asTicked = [...ticked]
  const names = { ...realNames }
  return {
    held: (people) => heldPicks(people, asTicked, names, ledger).length > 0,
    current: (people) => currentPicks(people, () => true, ledger),
    settled: () =>
      new Promise<void>((resolve) => {
        const stop = ledger.onSettle(() => {
          stop()
          resolve()
        })
      })
  }
}

/** The same people under the same logins: anything else needs a fresh answer. */
export const sameProposal = (next: readonly BotMember[], asked: readonly BotMember[]): boolean =>
  next.length === asked.length &&
  next.every(
    (member, index) => member.id === asked[index]?.id && member.name === asked[index]?.name
  )

/** Waits until no check the picker had already asked could still change one of `people` (only
 *  checks already out; each settles on its own bounds). */
export async function settledFor(
  people: readonly BotMember[],
  proposal?: WhoCanAskProposal
): Promise<void> {
  while (proposal?.held(people)) {
    await proposal.settled()
  }
}
