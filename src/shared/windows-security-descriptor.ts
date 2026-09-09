/**
 * Parses the DACL out of an SDDL string, as produced by `icacls <path> /save`.
 *
 * Why SDDL rather than the human-readable `icacls <path>` listing: the listing prints resolved
 * account *names*, which are localized and cannot be compared against a SID. Checking only the
 * shape of that listing — rule count, inheritance marker, rights — accepts a DACL that grants
 * full control to the wrong principal entirely. SDDL carries raw SIDs, so identity is checkable.
 */

/**
 * Aliases naming an account by RID within the machine's *own* SID, so no constant can hold them:
 * the built-in Administrator is `S-1-5-21-<machine>-500`, and icacls prints `LA` for it. A box
 * whose interactive user is that account (a CI runner, an Administrator-only install) therefore
 * reads back an ACE no fixed table can match.
 */
const LOCAL_DOMAIN_RELATIVE_RIDS: Record<string, number> = {
  LA: 500,
  LG: 501
}

/** `S-1-5-21-x-y-z-<rid>` split into the machine/domain authority and its RID. */
const DOMAIN_RELATIVE_SID_PATTERN = /^(S-1-5-21(?:-\d+){3})-\d+$/

/**
 * The machine/domain authority an account SID belongs to, or null when the SID is not
 * domain-relative (`S-1-5-18` and the `S-1-5-32-*` built-ins never are).
 */
export function localDomainSidOf(accountSid: string): string | null {
  return DOMAIN_RELATIVE_SID_PATTERN.exec(accountSid.toUpperCase())?.[1] ?? null
}

/** The two-letter aliases SDDL substitutes for well-known SIDs. */
const SDDL_SID_ALIASES: Record<string, string> = {
  AN: 'S-1-5-7',
  AU: 'S-1-5-11',
  BA: 'S-1-5-32-544',
  BG: 'S-1-5-32-546',
  BU: 'S-1-5-32-545',
  IU: 'S-1-5-4',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  NU: 'S-1-5-2',
  SY: 'S-1-5-18',
  WD: 'S-1-1-0'
}

export type WindowsAce = {
  /** `A` for allow, `D` for deny, plus the audit types. */
  type: string
  /** Two-letter inheritance/audit tokens, e.g. `['OI', 'CI']` or `['ID']`. */
  flags: string[]
  rights: string
  /**
   * Always a raw SID: aliases are resolved, unknown tokens are passed through upper-cased.
   * Machine-relative aliases resolve only when `localDomainSid` is supplied, so an unresolved
   * `LA` compares unequal to every real SID and the caller fails closed.
   */
  sid: string
}

export type WindowsDacl = {
  /** True when the DACL carries the `P` flag, i.e. inheritance from the parent is blocked. */
  isProtected: boolean
  aces: WindowsAce[]
}

export function parseSddlDacl(sddl: string, localDomainSid?: string): WindowsDacl | null {
  // ACE bodies never contain parentheses, so the group stops cleanly at a following `S:` SACL.
  const dacl = /D:([A-Z]*)((?:\([^()]*\))*)/.exec(sddl)
  if (!dacl) {
    return null
  }
  const aces: WindowsAce[] = []
  for (const group of dacl[2]!.matchAll(/\(([^()]*)\)/g)) {
    const fields = group[1]!.split(';')
    if (fields.length < 6) {
      return null
    }
    aces.push({
      type: fields[0]!.toUpperCase(),
      flags: splitAceFlags(fields[1]!),
      rights: fields[2]!.toUpperCase(),
      sid: resolveSddlSid(fields[5]!, localDomainSid)
    })
  }
  return { isProtected: dacl[1]!.includes('P'), aces }
}

/**
 * ACE flags are a run of two-letter tokens (`OICIID`), not a free-form string. Splitting them
 * keeps a substring search from reading `ID` out of an adjacent pair.
 */
function splitAceFlags(flags: string): string[] {
  const tokens: string[] = []
  for (let index = 0; index + 1 < flags.length; index += 2) {
    tokens.push(flags.slice(index, index + 2).toUpperCase())
  }
  return tokens
}

export function resolveSddlSid(token: string, localDomainSid?: string): string {
  const upper = token.toUpperCase()
  const rid = LOCAL_DOMAIN_RELATIVE_RIDS[upper]
  if (rid !== undefined) {
    return localDomainSid ? `${localDomainSid}-${rid}` : upper
  }
  return SDDL_SID_ALIASES[upper] ?? upper
}
