const EFFORT_RANK: ReadonlyMap<string, number> = new Map([
  ['none', 0],
  ['off', 0],
  ['minimal', 1],
  ['low', 2],
  ['medium', 3],
  ['high', 4],
  ['xhigh', 5],
  ['max', 6],
  ['ultra', 7]
])

const effortRank = (value: string): number | undefined => EFFORT_RANK.get(value.toLowerCase())

/** Display order only: agents may report levels highest-first. Unranked entries (Default, Auto,
 *  unknown levels) keep their slots; a known level appended to a listing moves to its rank. */
export function orderEffortLevels<T extends { value: string }>(choices: readonly T[]): T[] {
  const ranked = choices
    .filter((choice) => effortRank(choice.value) !== undefined)
    .sort((a, b) => effortRank(a.value)! - effortRank(b.value)!)
  let next = 0
  return choices.map((choice) =>
    effortRank(choice.value) === undefined ? choice : ranked[next++]!
  )
}
