import type { BrowserHttpAuthCredentials } from '../../../../shared/browser-http-auth'
import type { BrowserPagePromptHandler } from './browser-page-prompts'
import { translate } from '@/i18n/i18n'

export const httpAuthPrompt: BrowserPagePromptHandler<'http-auth'> = {
  ask: async (confirm, { origin, retry }, signal) => {
    let credentials: BrowserHttpAuthCredentials | null = null
    const lines = [
      translate(
        'auto.components.browserPane.httpAuth.description',
        '{{origin}} is asking for a username and password.',
        { origin }
      )
    ]
    if (origin.startsWith('http:')) {
      lines.push(
        translate(
          'auto.components.browserPane.httpAuth.insecure',
          "Your connection to this site isn't private."
        )
      )
    }
    if (retry) {
      lines.push(
        translate(
          'auto.components.browserPane.httpAuth.retry',
          "That username or password didn't work."
        )
      )
    }
    const confirmed = await confirm({
      signal,
      title: translate('auto.components.browserPane.httpAuth.title', 'Sign in'),
      description: lines.join('\n'),
      descriptionClassName: 'break-words',
      confirmLabel: translate('auto.components.browserPane.httpAuth.confirm', 'Sign in'),
      cancelLabel: translate('auto.components.browserPane.httpAuth.cancel', 'Cancel'),
      fields: {
        inputs: [
          {
            id: 'username',
            label: translate('auto.components.browserPane.httpAuth.username', 'Username'),
            autoComplete: 'username'
          },
          {
            id: 'password',
            label: translate('auto.components.browserPane.httpAuth.password', 'Password'),
            type: 'password',
            autoComplete: 'current-password'
          }
        ],
        onConfirmed: ({ username = '', password = '' }) => {
          credentials = { username, password }
        }
      }
    })
    return confirmed ? credentials : null
  }
}
