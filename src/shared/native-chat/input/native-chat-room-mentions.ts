/** Room member names for an `@` query: names starting with it first, then any containing it. */
export function rankNativeChatRoomMentions(names: readonly string[], query: string): string[] {
  const needle = query.toLocaleLowerCase()
  const starts = names.filter((name) => name.toLocaleLowerCase().startsWith(needle))
  return [
    ...starts,
    ...names.filter((name) => !starts.includes(name) && name.toLocaleLowerCase().includes(needle))
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
  const starts = members.filter((member) => member.name.toLocaleLowerCase().startsWith(needle))
  const named = members.filter((member) => !starts.includes(member) && has(member.name))
  const described = members.filter(
    (member) => !starts.includes(member) && !named.includes(member) && has(member.detail)
  )
  return [...starts, ...named, ...described].map((member) => member.key ?? member.name)
}
