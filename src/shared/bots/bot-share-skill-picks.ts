// Which of a bot's skills a Share dialog ticks.

/** The picked skill names, in the bot's order. An absent list is every skill except those a linked
 *  project links in from outside itself: the owner ticks those. */
export function pickedSkillNames(
  names: readonly string[] | undefined,
  skills: readonly { name: string; optInFrom?: string }[]
): string[] {
  return skills
    .filter((skill) => (names === undefined ? !skill.optInFrom : names.includes(skill.name)))
    .map((skill) => skill.name)
}
