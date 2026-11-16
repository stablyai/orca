// GH-ACTING-LINE: who a cloud workspace's pushes and PRs go out as right now, in words. The control
// plane decides (the only person, else a shared workspace's latest sender within the hour, else
// Orca's bot) and says so in the workspace's `githubActing`; this only puts it into words.
// Nothing when it's absent (an older control plane, a row the caller can't open), or for `off` /
// `not_github`.
import type { Translate } from '@/i18n/use-translate'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

export type CloudGitActing = Pick<CloudWorkspace, 'githubActing' | 'you'>

export type GitActingLine = {
  text: string
  /** It falls back to Orca's bot and the viewer hasn't connected GitHub: offer Connect GitHub. */
  connect: boolean
  /** The member it acts as, for the people tooltip; null for the bot. */
  userId: string | null
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
      connect: false,
      userId: acting.userId
    }
  }
  const connect = answer?.you?.connected === false
  switch (acting.reason) {
    case 'not_github':
    case 'off':
      return null
    case 'no_sender_yet':
      return {
        text: t(
          'cloudGitActing.noSenderYet',
          'Pushes and PRs go out as whoever sends next, or Orca bot'
        ),
        connect,
        userId: null
      }
    case 'window_expired':
      return {
        text: t(
          'cloudGitActing.stale',
          'Pushes and PRs go out as Orca bot (no one has sent in the last hour)'
        ),
        connect,
        userId: null
      }
    case 'transferred':
      // A workspace that changed owners is the App's on GitHub for good: connecting wouldn't change it.
      return { text: t('cloudGitActing.bot', 'Pushes and PRs go out as Orca bot'), connect: false, userId: null }
    case 'sender_not_connected':
    case 'reconnect':
      return {
        text: t('cloudGitActing.bot', 'Pushes and PRs go out as Orca bot'),
        connect,
        userId: null
      }
  }
}

/** The caveat that holds whatever the line says. */
export function gitActingCaveat(t: Translate): string {
  return t(
    'cloudGitActing.caveat',
    'Approvals always go out as Orca bot, and so do merges in shared workspaces.'
  )
}
