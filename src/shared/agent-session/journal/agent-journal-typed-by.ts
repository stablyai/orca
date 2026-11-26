/** Where a person's sent message was typed, from its transport: at the host's own window, on a
 *  paired device (a phone or another desktop), or by the orca CLI an agent runs. Absent on host-made
 *  messages and ones from before it was kept. A device's `account` is the Orca account name it
 *  claimed when the message was sent: unverified, shown by name only. `accountId` is that claim's
 *  id; `own` compares it with the host's account at send (absent when either side had none);
 *  `computer` names the computer the claim came from, and `phone` the relayed phone it was typed on.
 *  An agent's orca CLI on a paired device keeps that device and its `own` the same way. */
export type AgentJournalTypedBy =
  | { by: 'host' }
  | {
      by: 'device'
      deviceId: string
      account?: string
      accountId?: string
      own?: boolean
      computer?: string
      phone?: string
    }
  | { by: 'agent'; deviceId?: string; own?: boolean }

/** A person's message typed on a paired computer, as its sender line draws it: `accountId` is whose,
 *  `own` the host's comparison of it with the host's account (see `AgentJournalTypedBy`). */
export type PersonTypist = {
  name: string
  accountId: string
  own?: boolean
  computer?: string
  phone?: string
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Who typed a device message, when it claimed a named account; whether that is the viewer is
 *  `typistOtherThanViewer`'s to say. */
export function personTypistOf(typedBy: AgentJournalTypedBy | undefined): PersonTypist | undefined {
  if (typedBy?.by !== 'device') {
    return undefined
  }
  const accountId = nonEmpty(typedBy.accountId)
  const name = nonEmpty(typedBy.account)
  if (!accountId || !name) {
    return undefined
  }
  const computer = nonEmpty(typedBy.computer)
  const phone = nonEmpty(typedBy.phone)
  return {
    name,
    accountId,
    ...(typedBy.own !== undefined ? { own: typedBy.own } : {}),
    ...(computer ? { computer } : {}),
    ...(phone ? { phone } : {})
  }
}

/** The one rule for a sender line: the typist is someone other than the person looking. A viewer
 *  that knows its account compares with it, so a teammate's own messages draw none on their computer.
 *  One that doesn't (a phone has no sign-in) sees the host's comparison; unknown is never other. */
export function typistOtherThanViewer(
  typist: PersonTypist | undefined,
  viewerAccountId: string | null | undefined
): PersonTypist | undefined {
  if (!typist) {
    return undefined
  }
  const other = viewerAccountId ? typist.accountId !== viewerAccountId : typist.own === false
  return other ? typist : undefined
}

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

/** "Sam Lee · Sam's MacBook Pro", and its spoken/tooltip form, the same on desktop and phone. */
export function otherPersonTypistWords(
  typist: PersonTypist,
  t: Translate
): { name: string; computer: string; label: string } {
  const computer =
    typist.computer ?? t('components.native-chat.typedBy.anotherComputer', 'another computer')
  const label = typist.phone
    ? t(
        'components.native-chat.typedBy.fromViaPhone',
        'From {{name}}, typed on {{phone}} via {{computer}}',
        {
          name: typist.name,
          phone: typist.phone,
          computer
        }
      )
    : t('components.native-chat.typedBy.fromVia', 'From {{name}} via {{computer}}', {
        name: typist.name,
        computer
      })
  return { name: typist.name, computer, label }
}
