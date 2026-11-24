// The carousel's faces in order: the mascots with the custom picture after the mascot it was
// chosen from, the opt-in shape last, and Generate, when an agent can make pictures, left of the
// face selected at open.
import { PICKABLE_BOT_MASCOT_IDS, type BotMascotId } from '../../../../shared/bot-avatar'

export type PictureFaceKey = 'generate' | 'custom' | 'shape' | BotMascotId

export const GENERATE_FACE = 'generate' as const
export const CUSTOM_FACE = 'custom' as const
export const SHAPE_FACE = 'shape' as const

/**
 * Where Generate sits: just left of the face selected when the picker opened, so one step back
 * reaches it. Fixed while the picker is open; a custom picture gone since then falls back to the
 * mascot after its old place.
 */
export type GenerateSlot =
  | { before: 'custom'; after: number }
  | { before: 'mascot'; index: number }
  | { before: 'shape' }

/** `customAfter`: where the custom picture sits (-1: before mascot 1), or null when none shows. */
export function pictureFaceOrder(
  customAfter: number | null,
  generate: GenerateSlot | null,
  withShape = false
): PictureFaceKey[] {
  const mascots: PictureFaceKey[] = [...PICKABLE_BOT_MASCOT_IDS]
  const faces = [
    ...(customAfter === null
      ? mascots
      : [...mascots.slice(0, customAfter + 1), CUSTOM_FACE, ...mascots.slice(customAfter + 1)]),
    ...(withShape ? [SHAPE_FACE] : [])
  ]
  if (!generate) {
    return faces
  }
  const beforeCustom = generate.before === 'custom' && customAfter === generate.after
  const beforeShape = generate.before === 'shape' && withShape
  const mascot =
    generate.before === 'mascot'
      ? generate.index
      : generate.before === 'custom'
        ? generate.after + 1
        : 0
  const anchor = beforeCustom
    ? CUSTOM_FACE
    : beforeShape
      ? SHAPE_FACE
      : (mascots[mascot] ?? mascots[0])
  const at = faces.indexOf(anchor)
  return [...faces.slice(0, at), GENERATE_FACE, ...faces.slice(at)]
}

/** The generated picture, once applied, is the custom picture: it shows on Generate, not twice. */
export function isGeneratedCustom(
  customSrc: string | null | undefined,
  png: string | null
): boolean {
  return png !== null && customSrc === `data:image/png;base64,${png}`
}
