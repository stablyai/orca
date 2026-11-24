import { useCallback } from 'react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { botLinearWorkspaces, type Bot } from '../../../../shared/bot-types'

/** What "Not you?" signs out of: a Linear workspace, or the whole GitHub account. */
export type ConnectorSignOut =
  | { source: 'linear'; workspaceId: string; workspaceName: string }
  | { source: 'github'; login: string }

/** This computer's bots that answer there now: on for it, and not paused. */
export function botsAnsweringThere(
  bots: readonly Bot[],
  signOut: ConnectorSignOut
): readonly Bot[] {
  return bots.filter(
    (bot) =>
      !bot.paused &&
      (signOut.source === 'github'
        ? bot.github !== null
        : botLinearWorkspaces(bot).some((entry) => entry.workspaceId === signOut.workspaceId))
  )
}

/** "Scout", "Scout and Triage", "Scout, Triage and 2 others". */
export function botNamesLabel(names: readonly string[]): string {
  const [first = '', second = ''] = names
  if (names.length <= 1) {
    return first
  }
  if (names.length === 2) {
    return translate('bots.connect.signOut.twoBots', '{{first}} and {{second}}', { first, second })
  }
  return names.length === 3
    ? translate('bots.connect.signOut.botsAndOneOther', '{{first}}, {{second}} and 1 other', {
        first,
        second
      })
    : translate(
        'bots.connect.signOut.botsAndOthers',
        '{{first}}, {{second}} and {{others}} others',
        {
          first,
          second,
          others: names.length - 2
        }
      )
}

function signOutCopy(
  signOut: ConnectorSignOut,
  answering: readonly Bot[]
): { title: string; description: string } {
  const one = answering.length === 1
  const bots = botNamesLabel(answering.map((bot) => bot.name))
  if (signOut.source === 'linear') {
    const workspace = signOut.workspaceName
    return {
      title: translate('bots.linear.signOut.title', 'Sign out of {{workspace}}?', { workspace }),
      description: one
        ? translate(
            'bots.linear.signOut.one',
            '{{bots}} answers there now. It stops until you sign in to this workspace again.',
            { bots }
          )
        : translate(
            'bots.linear.signOut.many',
            '{{bots}} answer there now. They stop until you sign in to this workspace again.',
            { bots }
          )
    }
  }
  const login = signOut.login
  return {
    title: translate('bots.github.signOut.title', 'Sign out of GitHub as @{{login}}?', { login }),
    description: one
      ? translate(
          'bots.github.signOut.one',
          '{{bots}} answers on GitHub now. It stops until you sign in as @{{login}} again.',
          { bots, login }
        )
      : translate(
          'bots.github.signOut.many',
          '{{bots}} answer on GitHub now. They stop until you sign in as @{{login}} again.',
          { bots, login }
        )
  }
}

/** "Not you?" signs out; when bots answer there, the owner confirms first. True to go on. */
export function useConfirmConnectorSignOut(): (
  bots: readonly Bot[],
  signOut: ConnectorSignOut
) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    async (bots, signOut) => {
      const answering = botsAnsweringThere(bots, signOut)
      if (answering.length === 0) {
        return true
      }
      return await confirm({
        ...signOutCopy(signOut, answering),
        confirmLabel: translate('bots.connect.signOut.action', 'Sign out'),
        confirmVariant: 'destructive',
        surface: 'security'
      })
    },
    [confirm]
  )
}
