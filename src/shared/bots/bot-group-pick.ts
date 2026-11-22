// What the New / Edit group dialogs decide from a pick, shared by desktop and phone.

/** Kept members in their saved order, then new picks in pick order; the picture and the save use it. */
export function botGroupPickOrder(saved: readonly string[], picked: readonly string[]): string[] {
  return [
    ...saved.filter((id) => picked.includes(id)),
    ...picked.filter((id) => !saved.includes(id))
  ]
}

/** A new group needs two bots to talk; an existing room keeps working with one. */
export function botGroupMissing(
  count: number,
  name: string,
  editing: boolean
): 'pickTwo' | 'pickOne' | 'nameIt' | null {
  if (count < (editing ? 1 : 2)) {
    return editing ? 'pickOne' : 'pickTwo'
  }
  return name.trim() ? null : 'nameIt'
}

/** Whether an edit changes nothing: the same name and the same members in the same order. */
export function botGroupUnchanged(
  saved: { name: string; botIds: readonly string[] },
  name: string,
  botIds: readonly string[]
): boolean {
  return (
    name.trim() === saved.name &&
    botIds.length === saved.botIds.length &&
    botIds.every((id, index) => saved.botIds[index] === id)
  )
}

export type BotGroupNameSuggestion =
  | { key: 'suggestTwo'; values: { a: string; b: string } }
  | { key: 'suggestThree'; values: { a: string; b: string; c: string } }
  | { key: 'suggestMore'; values: { a: string; b: string; count: number } }

/** "Fern & Moss", "Fern, Moss & Ivy", "Fern, Moss & 3 more"; each client translates the key. */
export function botGroupNameSuggestion(names: readonly string[]): BotGroupNameSuggestion | null {
  const [a, b, c] = names
  if (!a || !b) {
    return null
  }
  if (!c) {
    return { key: 'suggestTwo', values: { a, b } }
  }
  return names.length === 3
    ? { key: 'suggestThree', values: { a, b, c } }
    : { key: 'suggestMore', values: { a, b, count: names.length - 2 } }
}

/** The name field's limit, which a suggestion is cut to. */
export const BOT_GROUP_NAME_MAX_LENGTH = 64
