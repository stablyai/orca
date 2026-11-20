// Connector setup copy that names the bot's computer: a paired server by name, else this computer.
import { translate } from '@/i18n/i18n'

/** A server's page couldn't open in its own session, where the return reaches the server. */
export const CONNECT_NOT_ROUTED = 'not_routed'

/** A setup's signed-out failure this window's own sign-in answers: no server named, or this computer's account failed. */
export function signedOutHere(
  failure: { code: string; local?: true },
  hostName: string | null
): boolean {
  return failure.code === 'signed_out' && (!hostName || failure.local === true)
}

/** The host's own errors every connector's setup shares; null for any other code. */
export function hostSetupErrorMessage(
  code: string,
  service: string,
  hostName: string | null
): string | null {
  switch (code) {
    case 'signed_out':
      return hostName
        ? translate(
            'bots.host.errors.signedOut',
            'Sign {{host}} in to Orca to connect {{service}}.',
            {
              host: hostName,
              service
            }
          )
        : null
    case 'account_changed':
      return hostName
        ? translate(
            'bots.host.errors.accountChanged',
            '{{host}}’s Orca sign-in changed. Start again.',
            {
              host: hostName
            }
          )
        : translate(
            'bots.host.errors.accountChangedHere',
            'This computer’s Orca sign-in changed. Start again.'
          )
    case CONNECT_NOT_ROUTED:
      return translate(
        'bots.host.errors.notRouted',
        '{{service}}’s page has to open in Orca’s browser for {{host}}. Reconnect {{host}}, then start again.',
        { service, host: hostName ?? '' }
      )
    default:
      return null
  }
}

/** "and {{name}} starts working on m4 air." for a server's bot; this computer's keeps its words. */
export function hostWorkPlace(hostName: string | null): string {
  return hostName ?? translate('bots.host.thisComputer', 'this computer')
}
