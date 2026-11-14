export type RepoLucideIconSearchOption = {
  name: string
  label: string
}

export function filterRepoLucideIconOptions<T extends RepoLucideIconSearchOption>(
  options: readonly T[],
  query: string
): T[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return [...options]
  }
  return options.filter((option) => {
    const haystack = `${option.label} ${option.name}`.toLowerCase()
    return haystack.includes(normalized)
  })
}
