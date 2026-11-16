// GH-ACTING-LINE: who a cloud workspace's pushes and PRs go out as right now, in words. The control
// plane decides (the solo owner, else the latest sender within the hour, else Orca's bot) and says
// so in `gitActor`; this only puts it into words. Nothing when the field is absent (not on GitHub,
// member identities off, an older control plane).
import type { Translate } from '@/i18n/use-translate'
import type { CloudWorkspaceGitActor } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

export type GitActingLine = {
  text: string
  /** The viewer could be the one it acts as, but hasn't connected GitHub: offer Connect GitHub. */
  connect: boolean
}

export function gitActingLine(
  answer: CloudWorkspaceGitActor | null,
  t: Translate
): GitActingLine | null {
  const actor = answer?.gitActor
  if (!actor) {
    return null
  }
  if (actor.kind === 'member') {
    return {
      text: t('cloudGitActing.member', 'Pushes and PRs go out as @{{login}}', {
        login: actor.login
      }),
      connect: false
    }
  }
  return {
    text:
      actor.reason === 'stale'
        ? t(
            'cloudGitActing.stale',
            'Pushes and PRs go out as Orca bot (no one has sent in the last hour)'
          )
        : t('cloudGitActing.bot', 'Pushes and PRs go out as Orca bot'),
    connect: answer?.viewerConnected === false
  }
}

/** The caveat that holds whatever the line says. */
export function gitActingCaveat(t: Translate): string {
  return t(
    'cloudGitActing.caveat',
    'Approvals always go out as Orca bot, and so do merges in shared workspaces.'
  )
}
