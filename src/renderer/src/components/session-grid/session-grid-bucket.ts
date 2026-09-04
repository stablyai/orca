import {
  sessionGridDotStateBucket,
  type SessionGridItem,
  type SessionGridStateFilter
} from '../../../../shared/session-grid-types'

/**
 * Which state chip a card answers to — the dot state alone, deliberately, after P4.
 *
 * P4 landed `hasUnread`/`attentionBadge` and did NOT fold them in here. The two answer
 * different questions: the bucket says what the agent is doing (and `done` therefore holds
 * a finished turn until its status goes stale, whether or not you attended it), while the
 * badge says whether you have seen it. Folding unread into `attention` would move a card
 * between chips on a click that changed nothing about the session, and the chip counts are
 * the one thing P3 spent its review making stable.
 *
 * The seam stays here rather than in `sessionGridDotStateBucket` so a later plan can change
 * its mind in one place. Extend this, do not fork it.
 */
export function sessionGridBucket(
  item: Pick<SessionGridItem, 'dotState'>
): Exclude<SessionGridStateFilter, 'all'> {
  return sessionGridDotStateBucket(item.dotState)
}
