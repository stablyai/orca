import type { AgentStatus } from '../agent-title-core'
import type { ProgramActivityChange } from '../agent-status-osc'

/** An activity change to apply before the title at `beforeTitle` (`titles.length`: after them all). */
export type PlacedProgramActivity = { beforeTitle: number; activity: AgentStatus | null }

/** Interleave explicit activity with titles in chunk order; titles preceding a later Clear must use the activity that existed then. */
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
