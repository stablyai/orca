// OWNER-TRANSFER: every sentence about a workspace changing owner, in one place. A workspace whose
// owner ever changed runs like a shared workspace for good (nobody's personal secrets or sign-ins),
// and whatever was on its disk went with it, so the previous owner is told to rotate.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  OwnerChangeNotice,
  PreviousOwner
} from '../../../../shared/cloud-workspaces/owner-change-wire'
import { formatWorkspaceNumber } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

/** The chip in the workspace's top bar. */
export function ownerChangedLabel(t: Translate = translate): string {
  return t('auto.components.cloudWorkspaces.ownerChange.chip', 'Owner changed')
}

/** Why it matters, under the chip and in the sidebar's hover card. */
export function ownerChangedExplanation(t: Translate = translate): string {
  return t(
    'auto.components.cloudWorkspaces.ownerChange.explanation',
    'This workspace has had more than one owner. Files left by earlier owners may run when it’s used, so no one’s personal secrets or sign-ins are used here.'
  )
}

/**
 * What the change does, listed in the confirmation before the sentence about managing it.
 * `owner` names the current owner when someone else (a team admin) is making the change.
 */
export function ownerChangeConsequences(owner: string | null, t: Translate = translate): string[] {
  return [
    t(
      'auto.components.cloudWorkspaces.ownerChange.sleeps',
      'It goes to sleep now, and its share links stop working.'
    ),
    t(
      'auto.components.cloudWorkspaces.ownerChange.disk',
      'Everything on its disk goes with it, including files and any sign-ins saved inside it.'
    ),
    owner
      ? t(
          'auto.components.cloudWorkspaces.ownerChange.sharedForGoodOther',
          'From now on it runs like a shared workspace, even if it goes back to {{owner}}. No one’s personal secrets or sign-ins are used in it.',
          { owner }
        )
      : t(
          'auto.components.cloudWorkspaces.ownerChange.sharedForGood',
          'From now on it runs like a shared workspace, even if it comes back to you. No one’s personal secrets or sign-ins are used in it.'
        ),
    owner
      ? t(
          'auto.components.cloudWorkspaces.ownerChange.secretsOnDiskOther',
          'Personal secrets {{owner}} used in it may still be on its disk.',
          { owner }
        )
      : t(
          'auto.components.cloudWorkspaces.ownerChange.secretsOnDisk',
          'Personal secrets you used in it may still be on its disk.'
        )
  ]
}

/**
 * A refusal the confirmation shows in place: nothing changed, and the sentence says what to do.
 * Null for anything else, which keeps the shared control-plane copy.
 */
export function ownerChangeRefusal(
  error: string,
  reason: string | undefined,
  name: string,
  t: Translate = translate
): string | null {
  if (error === 'forbidden' && reason === 'not_a_member') {
    return t(
      'auto.components.cloudWorkspaces.ownerChange.notAMember',
      '{{name}} isn’t a member of this team.',
      { name }
    )
  }
  if (error === 'unavailable' && reason === 'membership_unavailable') {
    return t(
      'auto.components.cloudWorkspaces.ownerChange.membershipUnavailable',
      'Couldn’t confirm that {{name}} is a member of this team. Try again in a minute.',
      { name }
    )
  }
  if (error === 'timeout') {
    // Not "nothing was changed": the change may still land after we stopped waiting.
    return t(
      'auto.components.cloudWorkspaces.ownerChange.slow',
      'This is taking longer than expected. Check who owns the workspace before you try again.'
    )
  }
  if (error !== 'conflict') {
    return null
  }
  if (reason === 'stop_failed') {
    return t(
      'auto.components.cloudWorkspaces.ownerChange.stopFailed',
      'Couldn’t put this workspace to sleep, so the owner didn’t change. Try again.'
    )
  }
  if (reason === 'sandbox_not_stopped') {
    return t(
      'auto.components.cloudWorkspaces.ownerChange.notStopped',
      'Someone opened this workspace during the change, so the owner didn’t change. It may be asleep now. Try again.'
    )
  }
  return reason?.startsWith('sandbox_')
    ? t(
        'auto.components.cloudWorkspaces.ownerChange.busy',
        'This workspace is starting or going to sleep. Try again once it’s done.'
      )
    : null
}

/**
 * What the person who made the change is told about the previous owner. Null when there is
 * nothing to add to "Owner changed": they were the owner themselves (they get the notice), or an
 * older control plane did not say.
 */
export function previousOwnerToast(
  previous: PreviousOwner | null,
  selfId: string | null,
  /** Their name, or null when nobody can name them any more. */
  name: string | null,
  t: Translate = translate
): string | null {
  if (!previous || previous.userId === selfId) {
    return null
  }
  // A notice waiting for them, not one they have read.
  if (previous.inApp) {
    return name
      ? t(
          'auto.components.cloudWorkspaces.ownerChange.toastTold',
          '{{name}} will see a notice in Orca. If they used personal secrets in this workspace, they should rotate them.',
          { name }
        )
      : t(
          'auto.components.cloudWorkspaces.ownerChange.toastToldUnnamed',
          'The previous owner will see a notice in Orca. If they used personal secrets in this workspace, they should rotate them.'
        )
  }
  return name
    ? t(
        'auto.components.cloudWorkspaces.ownerChange.toastLeft',
        '{{name}} has left the team, so Orca can’t tell them. If they used personal secrets in this workspace, ask them to rotate them.',
        { name }
      )
    : t(
        'auto.components.cloudWorkspaces.ownerChange.toastLeftUnnamed',
        'A former member owned this workspace, so Orca can’t tell them. If they used personal secrets in this workspace, ask them to rotate them.'
      )
}

function noticeWorkspace(notice: OwnerChangeNotice, t: Translate): string {
  return (
    notice.workspace.name?.trim().slice(0, 80) ||
    (notice.workspace.number ? formatWorkspaceNumber(notice.workspace.number) : '') ||
    t('auto.components.cloudWorkspaces.ownerChange.aWorkspace', 'a workspace')
  )
}

/** The previous owner's notice: who did it, and why they might rotate. */
export function previousOwnerNotice(
  notice: OwnerChangeNotice,
  selfId: string | null,
  /** A name from the team roster, for people the control plane could not name. */
  nameOf: (userId: string) => string | null,
  t: Translate = translate
): { text: string; description: string } {
  const workspace = noticeWorkspace(notice, t)
  // The actor starts the sentence; the new owner is always inside it.
  const actor =
    notice.actor.name ||
    nameOf(notice.actor.userId) ||
    t('auto.components.cloudWorkspaces.ownerChange.aTeammate', 'A teammate')
  const newOwner =
    notice.newOwner.name ||
    nameOf(notice.newOwner.userId) ||
    t('auto.components.cloudWorkspaces.ownerChange.aTeammateInline', 'a teammate')
  const text =
    notice.actor.userId === selfId
      ? t(
          'auto.components.cloudWorkspaces.ownerChange.noticeYouMade',
          'You made {{newOwner}} the owner of {{workspace}}.',
          { newOwner, workspace }
        )
      : notice.actor.userId === notice.newOwner.userId
        ? t(
            'auto.components.cloudWorkspaces.ownerChange.noticeTook',
            '{{actor}} took ownership of {{workspace}}.',
            { actor, workspace }
          )
        : t(
            'auto.components.cloudWorkspaces.ownerChange.noticeMade',
            '{{actor}} made {{newOwner}} the owner of {{workspace}}.',
            { actor, newOwner, workspace }
          )
  return {
    text,
    description: t(
      'auto.components.cloudWorkspaces.ownerChange.noticeRotate',
      'Personal secrets you used in it may still be on its disk, so consider rotating them.'
    )
  }
}

export function previousOwnerNoticeAction(t: Translate = translate): string {
  return t('auto.components.cloudWorkspaces.ownerChange.openSecrets', 'Open Cloud secrets')
}

/** The new owner's notice, shown once. */
export function newOwnerNotice(
  workspace: string,
  t: Translate = translate
): { text: string; description: string; action: string } {
  return {
    text: t(
      'auto.components.cloudWorkspaces.ownerChange.newOwnerTitle',
      'You’re now the owner of {{workspace}}',
      { workspace }
    ),
    description: t(
      'auto.components.cloudWorkspaces.ownerChange.newOwnerBody',
      'It runs like a shared workspace, so your personal secrets and sign-ins aren’t used here. To use them, create a new workspace.'
    ),
    action: t('auto.components.cloudWorkspaces.ownerChange.newWorkspace', 'New workspace')
  }
}
