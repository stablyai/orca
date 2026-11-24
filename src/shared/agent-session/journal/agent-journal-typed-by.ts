/** Where a person's sent message was typed, from its transport: at the host's own window, on a
 *  paired device (a phone or another desktop), or by the orca CLI an agent runs. Absent on host-made
 *  messages and ones from before it was kept. A device's `account` is the Orca account name it
 *  claimed when the message was sent: unverified, shown by name only. `accountId` is that claim's
 *  id; `own` compares it with the host's account at send (absent when either side had none);
 *  `computer` names the computer the claim came from, and `phone` the relayed phone it was typed on. */
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
  | { by: 'agent' }

/** A message another person typed on their paired computer, as its sender line draws it. */
export type OtherPersonTypist = { name: string; computer?: string; phone?: string }

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Only a claimed account the host compared and found different draws a line: unknown is not other. */
export function otherPersonTypistOf(
  typedBy: AgentJournalTypedBy | undefined
): OtherPersonTypist | undefined {
  if (typedBy?.by !== 'device' || typedBy.own !== false || !nonEmpty(typedBy.accountId)) {
    return undefined
  }
  const name = nonEmpty(typedBy.account)
  if (!name) {
    return undefined
  }
  const computer = nonEmpty(typedBy.computer)
  const phone = nonEmpty(typedBy.phone)
  return { name, ...(computer ? { computer } : {}), ...(phone ? { phone } : {}) }
}

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

/** "Sam Lee · Sam's MacBook Pro", and its spoken/tooltip form, the same on desktop and phone. */
export function otherPersonTypistWords(
  typist: OtherPersonTypist,
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
