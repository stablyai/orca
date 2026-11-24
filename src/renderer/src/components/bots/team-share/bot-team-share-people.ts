// What the Share dialog draws: everyone who can ask the agent, and what the Add field found.
// Orca accounts and invites come from the agent's shares; Slack and GitHub people from its members.
import {
  BotShareEmailSchema,
  normalizeShareEmail,
  type BotShare
} from '../../../../../shared/bots/bot-team-shares'

export type TeamShareLinkSource = 'slack' | 'github' | 'linear'

export type TeamSharePerson =
  | {
      kind: 'account'
      key: string
      name: string
      email: string
      /** Accounts this person linked to their Orca account themselves. */
      links: readonly TeamShareLinkSource[]
    }
  | {
      kind: 'invite'
      key: string
      email: string
      /** False while the invite email waits on its hourly limit. */
      emailSent: boolean
    }
  | {
      kind: 'slack'
      key: string
      name: string
      /** Their @name, when the row knows it; saved people keep only their name. */
      handle?: string
      workspace: string
    }
  | {
      kind: 'github'
      key: string
      login: string
      /** The org or repo owner it was added from. */
      place: string
      /** Set when this login is linked to several Orca accounts, so it stays its own row. */
      linkedAccounts?: number
    }

export type TeamShareSuggestion =
  | {
      kind: 'account'
      key: string
      name: string
      detail: string
      links: readonly TeamShareLinkSource[]
    }
  | { kind: 'slack' | 'github'; key: string; name: string; detail?: string }
  | { kind: 'invite'; key: string; email: string }

export type TeamShareOwner = {
  name: string
  email: string
  links: readonly TeamShareLinkSource[]
}

export function teamSharePersonName(person: TeamSharePerson): string {
  switch (person.kind) {
    case 'invite':
      return person.email
    case 'github':
      return person.login
    case 'account':
    case 'slack':
      return person.name
  }
}

/** The bot's share list as rows, keyed by shareId: Has access for an account, Invited for an email. */
export function teamSharePeople(shares: readonly BotShare[] | undefined): TeamSharePerson[] {
  return (shares ?? []).map((share) =>
    share.kind === 'account'
      ? {
          kind: 'account',
          key: share.shareId,
          name: share.name ?? share.email,
          email: share.email,
          links: []
        }
      : {
          kind: 'invite',
          key: share.shareId,
          email: share.email,
          emailSent: share.emailedAt !== undefined
        }
  )
}

/** What the Add field offers: an invite for a typed email not on the list yet, else no match. */
export function teamShareSuggestions(
  query: string,
  shares: readonly BotShare[] | undefined
): TeamShareSuggestion[] | null {
  const email = normalizeShareEmail(query)
  if (email === '') {
    return null
  }
  if (!BotShareEmailSchema.safeParse(email).success) {
    return []
  }
  return (shares ?? []).some((share) => share.email === email)
    ? []
    : [{ kind: 'invite', key: email, email }]
}
