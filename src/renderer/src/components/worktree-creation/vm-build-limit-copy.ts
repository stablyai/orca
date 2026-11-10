import type { Translate } from '@/i18n/use-translate'
import type { SandboxLimit } from './vm-build-failure-copy'

/** Body of the running-sandbox limit cards, pluralized ("1 sandbox … Put it to sleep"). */
export function sandboxLimitBody(
  t: Translate,
  scope: 'team' | 'member',
  limit: SandboxLimit | null | undefined
): string {
  if (!limit) {
    return t(
      'auto.components.worktree.creation.VmBuildFailureCard.limitBody',
      'Put one to sleep or delete it, then try again. Nothing was created, and you weren’t charged.'
    )
  }
  if (scope === 'team') {
    return t(
      'auto.components.worktree.creation.VmBuildFailureCard.teamLimitBodyCount',
      'Your team can run {{count}} sandboxes at once ({{value1}} per seat). Put one to sleep or delete it, then try again. Nothing was created, and you weren’t charged.',
      {
        count: limit.team,
        value1: String(limit.perSeat),
        defaultValue_one:
          'Your team can run {{count}} sandbox at once ({{value1}} per seat). Put it to sleep or delete it, then try again. Nothing was created, and you weren’t charged.'
      }
    )
  }
  return t(
    'auto.components.worktree.creation.VmBuildFailureCard.memberLimitBodyCount',
    'You can run {{count}} sandboxes at once. Put one to sleep or delete it, then try again. Nothing was created, and you weren’t charged.',
    {
      count: limit.perSeat,
      defaultValue_one:
        'You can run {{count}} sandbox at once. Put it to sleep or delete it, then try again. Nothing was created, and you weren’t charged.'
    }
  )
}
