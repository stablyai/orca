// GH-ACTING-LINE: who a cloud workspace's pushes and PRs go out as right now, in words. The control
// plane decides (its owner, else Orca's bot) and says so in the workspace's `githubActing`; this only
// puts it into words. Nothing when it's absent (an older control plane, a row the caller can't open),
// or for `off` / `not_github`.
import type { Translate } from '@/i18n/use-translate'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

export type CloudGitActing = Pick<CloudWorkspace, 'githubActing' | 'you'>

export type GitActingLine = {
  text: string
  /** It falls back to Orca's bot and the viewer hasn't connected GitHub: offer Connect GitHub. */
  connect: boolean
}

export function gitActingLine(answer: CloudGitActing | null, t: Translate): GitActingLine | null {
  const acting = answer?.githubActing
  if (!acting) {
    return null
  }
  if (acting.actingAs === 'member') {
    return {
      text: t('cloudGitActing.member', 'Pushes and PRs go out as @{{login}}', {
        login: acting.login
      }),
      connect: false
    }
  }
  const bot = t('cloudGitActing.bot', 'Pushes and PRs go out as Orca bot')
  switch (acting.reason) {
    case 'not_github':
    case 'off':
      return null
    case 'transferred':
      // A workspace that changed owners is the App's on GitHub for good: connecting wouldn't change it.
      return { text: bot, connect: false }
    // `no_sender_yet`, `sender_not_connected` and `window_expired` come only from control planes
    // that still had team sharing; they read as the plain bot line.
    case 'no_sender_yet':
    case 'sender_not_connected':
    case 'window_expired':
    case 'reconnect':
      return { text: bot, connect: answer?.you?.connected === false }
  }
}

/** The caveat that holds whatever the line says: approvals are refused inside a workspace. */
export function gitActingCaveat(t: Translate): string {
  return t('cloudGitActing.caveat', 'Approve pull requests on GitHub. Workspaces can’t approve.')
}
