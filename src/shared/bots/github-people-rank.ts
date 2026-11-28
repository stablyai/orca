// Who can ask › Add on GitHub: how the people read from the connected repositories are matched
// against what the owner types, by login and real name, best first.

export type GitHubPerson = { id: string; login: string; name: string | null }

// Lower is better: exact login, login prefix, a name word's prefix, then anywhere in either.
function matchRank(person: GitHubPerson, needle: string): number {
  const login = person.login.toLowerCase()
  const name = person.name?.toLowerCase() ?? ''
  if (needle === '' || login === needle) {
    return 0
  }
  if (login.startsWith(needle)) {
    return 1
  }
  if (name.startsWith(needle) || name.split(/\s+/).some((word) => word.startsWith(needle))) {
    return 2
  }
  return login.includes(needle) || name.includes(needle) ? 3 : -1
}

/** Unique people matching `query`, best first; an empty query keeps everyone, by login. */
export function rankGitHubPeople(people: readonly GitHubPerson[], query: string): GitHubPerson[] {
  const needle = query.trim().replace(/^@/, '').toLowerCase()
  const byId = new Map<string, { person: GitHubPerson; rank: number }>()
  for (const person of people) {
    const rank = matchRank(person, needle)
    if (rank >= 0 && !byId.has(person.id)) {
      byId.set(person.id, { person, rank })
    }
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.person.login.toLowerCase().localeCompare(right.person.login.toLowerCase())
    )
    .map((entry) => entry.person)
}
