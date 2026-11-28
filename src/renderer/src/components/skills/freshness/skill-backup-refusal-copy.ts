import type { BundledSkillRefusalNotice } from '../../../../../shared/skills/bundled/bundled-skill-backup-refusal'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** The path is never part of a sentence: it sits on its own line between `reason` and `next`. */
export type SkillRefusalLines = { reason: string; path: string; next: string }

/** Why a copy stayed on another drive, and what the user can do about it. */
export function skillRefusalLines(
  notice: BundledSkillRefusalNotice,
  t: Translate = translate
): SkillRefusalLines {
  // A copy no later plan mentions (put back in place, or a former root's) gets no reminder.
  const noReminder = (): string =>
    t(
      'auto.components.skills.skillBackupRefusal.noReminder',
      "Move it out of the skills folder. Orca won't remind you."
    )
  switch (notice.source) {
    case 'in-place':
      return {
        reason: t(
          'auto.components.skills.skillBackupRefusal.inPlaceReason',
          "Can't back it up: it's on another drive."
        ),
        path: notice.path,
        next: notice.offeredAgain
          ? t(
              'auto.components.skills.skillBackupRefusal.tryAgain',
              'Move it out of the skills folder, then try again.'
            )
          : noReminder()
      }
    case 'leftover':
      return {
        reason: t(
          'auto.components.skills.skillBackupRefusal.leftoverReason',
          "Can't back up the left-over copy: it's on another drive."
        ),
        path: notice.path,
        next: t(
          'auto.components.skills.skillBackupRefusal.tryAgain',
          'Move it out of the skills folder, then try again.'
        )
      }
    case 'moved-aside':
      return {
        reason: t(
          'auto.components.skills.skillBackupRefusal.movedAsideReason',
          "Couldn't back up the old copy: it's on another drive."
        ),
        path: notice.path,
        next: notice.offeredAgain
          ? t(
              'auto.components.skills.skillBackupRefusal.keepIt',
              'Move it out of the skills folder to keep it.'
            )
          : noReminder()
      }
  }
}
