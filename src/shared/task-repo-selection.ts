/** Task peers use raw repository choices; the bundled owner retains exact host refinements. */
export function taskRepoSelectionRawId(token: string): string {
  return token.slice(token.indexOf('\0') + 1)
}

export function projectRawTaskRepoSelection(
  selection: readonly string[] | null | undefined
): string[] | null {
  return selection == null ? null : [...new Set(selection.map(taskRepoSelectionRawId))]
}

export function replaceRawTaskRepoSelection(
  current: readonly string[] | null | undefined,
  incoming: readonly string[] | null
): string[] | null {
  if (incoming === null) {
    return null
  }
  const retained = new Map<string, string[]>()
  for (const token of current ?? []) {
    const id = taskRepoSelectionRawId(token)
    const tokens = retained.get(id) ?? []
    tokens.push(token)
    retained.set(id, tokens)
  }
  return [...new Set(incoming.map(taskRepoSelectionRawId))].flatMap(
    (id) => retained.get(id) ?? [id]
  )
}
