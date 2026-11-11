/** Approximate two dialog lines before offering Show more so long trigger docs do not bury controls. */
export const SKILL_DESCRIPTION_CLAMP_CHARS = 160

export function isLongSkillDescription(description: string | null | undefined): boolean {
  return (description?.trim().length ?? 0) > SKILL_DESCRIPTION_CLAMP_CHARS
}
