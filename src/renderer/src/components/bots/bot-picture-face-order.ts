// The carousel's faces in order: Generate first when an agent can make pictures, then the
// mascots with the custom picture after the mascot it was chosen from.
import { PICKABLE_BOT_MASCOT_IDS, type BotMascotId } from '../../../../shared/bot-avatar'

export type PictureFaceKey = 'generate' | 'custom' | BotMascotId

export const GENERATE_FACE = 'generate' as const
export const CUSTOM_FACE = 'custom' as const

/** `customAfter`: where the custom picture sits (-1: before mascot 1), or null when none shows. */
export function pictureFaceOrder(customAfter: number | null, generate: boolean): PictureFaceKey[] {
  const mascots: PictureFaceKey[] = [...PICKABLE_BOT_MASCOT_IDS]
  const faces =
    customAfter === null
      ? mascots
      : [...mascots.slice(0, customAfter + 1), CUSTOM_FACE, ...mascots.slice(customAfter + 1)]
  return generate ? [GENERATE_FACE, ...faces] : faces
}

/** The generated picture, once applied, is the custom picture: it shows on Generate, not twice. */
export function isGeneratedCustom(
  customSrc: string | null | undefined,
  png: string | null
): boolean {
  return png !== null && customSrc === `data:image/png;base64,${png}`
}
