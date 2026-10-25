import type { AgentStatus } from '../agent-title-core'
import type { ProgramActivityChange } from '../agent-status-osc'

/** An activity change to apply before the title at `beforeTitle` (`titles.length`: after them all). */
export type PlacedProgramActivity = { beforeTitle: number; activity: AgentStatus | null }

/**
 * Orders a chunk's OSC 7501 activity changes among its titles. Why: explicit activity outranks a
 * title only while it exists, so a title read before a later Clear must not be judged after it.
 */
export function placeProgramActivityAmongTitles(
  titleEnds: readonly number[],
  activity: readonly ProgramActivityChange[]
): PlacedProgramActivity[] {
  let titleIndex = 0
  return activity.map((change) => {
    while (titleIndex < titleEnds.length && titleEnds[titleIndex] <= change.offset) {
      titleIndex += 1
    }
    return { beforeTitle: titleIndex, activity: change.activity }
  })
}
