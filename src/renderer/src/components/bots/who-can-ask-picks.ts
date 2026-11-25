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

/** Picks a username check still out could re-identify: its login is theirs, or it matches their
 *  login or real name (it may find their id under a new login). Others can be added meanwhile. */
export function heldPicks(
  picks: readonly BotMember[],
  realNames: Readonly<Record<string, string>>,
  ledger: WhoCanAskIdentityLedger
): BotMember[] {
  const pending = ledger.pending()
  if (pending.length === 0) {
    return []
  }
  return picks.filter((member) =>
    pending.some(
      (login) =>
        (member.name || member.id).toLowerCase().includes(login) ||
        (realNames[member.id] ?? '').toLowerCase().includes(login)
    )
  )
}
