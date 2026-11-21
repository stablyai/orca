// Spaces and punctuation don't count, so `@eng-rev` or `@eng - rev` finds "Eng - Reviewer".
const fold = (text: string): string => text.toLocaleLowerCase().replace(/[\s\p{P}]+/gu, '')

/** Whether a room member's name holds an `@` query, ignoring case, spaces and punctuation. */
export function nativeChatRoomNameMatches(name: string, query: string): boolean {
  return fold(name).includes(fold(query))
}

export function nativeChatRoomNameEquals(name: string, query: string): boolean {
  return fold(name) === fold(query)
}

/** Room member names for an `@` query: names starting with it first, then any containing it. */
export function rankNativeChatRoomMentions(names: readonly string[], query: string): string[] {
  const needle = fold(query)
  const starts = names.filter((name) => fold(name).startsWith(needle))
  return [
    ...starts,
    ...names.filter((name) => !starts.includes(name) && nativeChatRoomNameMatches(name, query))
  ]
}

/** The same, for members with a detail line (what a bot is for): after the name matches, those whose
 *  detail contains the query. Each is returned as its `key`, or its name without one, so members
 *  that share a name stay apart. */
export function rankNativeChatRoomMembers(
  members: readonly { name: string; detail?: string; key?: string }[],
  query: string
): string[] {
  const needle = query.toLocaleLowerCase()
  const has = (text: string | undefined) => text?.toLocaleLowerCase().includes(needle) === true
  const starts = members.filter((member) => fold(member.name).startsWith(fold(query)))
  const named = members.filter(
    (member) => !starts.includes(member) && nativeChatRoomNameMatches(member.name, query)
  )
  const described = members.filter(
    (member) => !starts.includes(member) && !named.includes(member) && has(member.detail)
  )
  return [...starts, ...named, ...described].map((member) => member.key ?? member.name)
}
