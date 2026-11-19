/** Side of the bot avatar slot a group's faces fill, in px; names line up with bot rows. */
export const BOT_GROUP_FACE_SLOT = 28
/** Clear gap cut around an overlapping face, in px. */
export const BOT_GROUP_FACE_GAP = 1.5

export type BotGroupFace<T> = {
  key: string
  /** A member, or how many more members the faces leave out. */
  face: { member: T } | { more: number }
  x: number
  y: number
  size: number
  /** An emoji or initial's size in this circle, in px. */
  font: number
}

type Spot = { x: number; y: number; size: number; font: number }
const PAIR: Spot[] = [
  { x: 11, y: 0, size: 17, font: 10 },
  { x: 0, y: 10, size: 18, font: 10 }
]
const TRIO: Spot[] = [
  { x: 14, y: 0, size: 14, font: 8 },
  { x: 0, y: 3, size: 15, font: 9 },
  { x: 5, y: 15, size: 13, font: 8 }
]

/** A group's circles, back to front: every member up to three; past that two faces and a "+N" circle.
 *  `scale` sizes the row's 28px picture for a larger slot. */
export function botGroupFaces<T>(
  members: readonly T[],
  keyOf: (member: T) => string,
  scale = 1
): BotGroupFace<T>[] {
  const [first, second, third] = members
  if (!first) {
    return []
  }
  const at = (spot: Spot, face: BotGroupFace<T>['face'], key: string): BotGroupFace<T> => ({
    key,
    face,
    x: spot.x * scale,
    y: spot.y * scale,
    size: spot.size * scale,
    font: spot.font * scale
  })
  if (!second) {
    return [at({ x: 4, y: 4, size: 20, font: 11 }, { member: first }, keyOf(first))]
  }
  if (!third) {
    return [
      at(PAIR[0]!, { member: second }, keyOf(second)),
      at(PAIR[1]!, { member: first }, keyOf(first))
    ]
  }
  return [
    at(TRIO[0]!, { member: second }, keyOf(second)),
    at(TRIO[1]!, { member: first }, keyOf(first)),
    members.length === 3
      ? at(TRIO[2]!, { member: third }, keyOf(third))
      : at({ ...TRIO[2]!, font: 7 }, { more: members.length - 2 }, 'more')
  ]
}

/** Size of one face in a group's tab icon, in px: a bot tab's avatar size. */
export const BOT_GROUP_TAB_FACE = 12
const TAB_FACE_STEP = 8

/** A group's tab icon, back to front: its first two members side by side, the first in front. */
export function botGroupTabFaces<T>(
  members: readonly T[],
  keyOf: (member: T) => string
): BotGroupFace<T>[] {
  const shown = members.slice(0, 2)
  return shown
    .map((member, index) => ({
      key: keyOf(member),
      face: { member },
      x: index * TAB_FACE_STEP,
      y: 0,
      size: BOT_GROUP_TAB_FACE,
      font: 7
    }))
    .toReversed()
}
