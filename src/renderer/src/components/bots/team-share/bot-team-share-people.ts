// What the Share dialog draws: everyone who can ask the agent, and what the Add field found.
// Orca accounts and invites come from the agent's shares; Slack and GitHub people from its members.

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
  | { kind: 'slack'; key: string; name: string; handle: string; workspace: string }
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
