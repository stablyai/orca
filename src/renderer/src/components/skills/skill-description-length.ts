/** Roughly two clamped lines at the width these dialogs use. Longer than this
 *  and the description gets a Show more toggle instead of burying the controls
 *  under a wall of prose. */
export const SKILL_DESCRIPTION_CLAMP_CHARS = 160

export function isLongSkillDescription(description: string | null | undefined): boolean {
  return (description?.trim().length ?? 0) > SKILL_DESCRIPTION_CLAMP_CHARS
}
