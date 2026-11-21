// Which of a bot's skills a Share dialog ticks.
import * as z from 'zod'

/** The owner's tick on a skill linked into a project from outside it: its name, and a key for the
 *  folder it was in when ticked. A skill linked in from another folder since is a new choice. */
export const BotShareOutsidePickSchema = z.object({
  name: z.string().min(1).max(200),
  key: z.string().min(1).max(64)
})
export type BotShareOutsidePick = z.infer<typeof BotShareOutsidePickSchema>

type Skill = { name: string; optInFrom?: string; optInKey?: string }

/** The picked skill names, in the bot's order. An absent list is every skill, but a skill a linked
 *  project links in from outside itself is picked only with the owner's tick on it in that folder. */
export function pickedSkillNames(
  names: readonly string[] | undefined,
  skills: readonly Skill[],
  outside: readonly BotShareOutsidePick[] = []
): string[] {
  return skills
    .filter(
      (skill) =>
        (names === undefined || names.includes(skill.name)) &&
        (skill.optInFrom === undefined ||
          outside.some((pick) => pick.name === skill.name && pick.key === skill.optInKey))
    )
    .map((skill) => skill.name)
}

/** The outside ticks with this skill's ticked or cleared. */
export function toggledOutside(
  outside: readonly BotShareOutsidePick[],
  skill: { name: string; optInKey: string },
  on: boolean
): BotShareOutsidePick[] {
  const others = outside.filter((pick) => pick.name !== skill.name)
  return on ? [...others, { name: skill.name, key: skill.optInKey }] : others
}
