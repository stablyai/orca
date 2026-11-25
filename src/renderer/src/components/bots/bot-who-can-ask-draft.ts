import { useLayoutEffect, useState } from 'react'
import type { BotMember } from '../../../../shared/bot-types'
import type { BotWhoCanAskSession } from './BotWhoCanAskList'
import { NO_IDENTITIES, type Identities } from './github/github-who-can-ask-identities'

const EMPTY_DRAFT: { members: BotMember[]; names: Record<string, string> } = {
  members: [],
  names: {}
}

export function confirmedDraftMembers(members: BotMember[], identities: Identities): BotMember[] {
  return members
    .filter((person) => !identities.superseded.has(person.id))
    .map((person) => {
      const name = identities.names[person.id]
      return name && name !== person.name ? { ...person, name } : person
    })
}

export function useMemberDraft(session: BotWhoCanAskSession | undefined) {
  const [draft, setDraft] = useState(() => ({ session, ...EMPTY_DRAFT }))
  useLayoutEffect(() => {
    setDraft((previous) => {
      if (previous.session === session) {
        return previous
      }
      // Carry settled picks forward with their live names. A retired lookup cannot validate a draft.
      const old = previous.session
      if (!old || !session || old.isCheckingIdentities?.()) {
        return { session, ...EMPTY_DRAFT }
      }
      return {
        session,
        members: confirmedDraftMembers(previous.members, old.readIdentities?.() ?? NO_IDENTITIES),
        names: previous.names
      }
    })
  }, [session])
  const toggle = (member: BotMember, realName?: string): void => {
    setDraft((previous) => {
      const current = previous.session === session ? previous : EMPTY_DRAFT
      return {
        session,
        members: current.members.some((entry) => entry.id === member.id)
          ? current.members.filter((entry) => entry.id !== member.id)
          : [...current.members, member],
        names: realName ? { ...current.names, [member.id]: realName } : current.names
      }
    })
  }
  return { ...(draft.session === session ? draft : EMPTY_DRAFT), toggle }
}
