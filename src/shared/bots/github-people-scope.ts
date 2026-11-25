// Who can ask › Add on GitHub lists the people of the repositories the Orca app is installed on,
// read once per picker open and filtered locally as the owner types.
// The renderer bounds and orders that scope here, so what it sends always passes the RPC's limits
// and the host searches the same repositories however the installations happen to be ordered.

/** Repositories read per picker open; more are reported as omitted. */
export const GITHUB_PEOPLE_MAX_REPOSITORIES = 10
/** Whole-account installs (an organization's members, or a person's own repositories). */
export const GITHUB_PEOPLE_MAX_OWNERS = 3

export type GitHubPeopleScope = {
  /** "owner/name", deduplicated and sorted, at most GITHUB_PEOPLE_MAX_REPOSITORIES. */
  repositories: string[]
  /** Accounts the app is installed on with every repository, at most GITHUB_PEOPLE_MAX_OWNERS. */
  owners: string[]
  /** True when the installations hold more than the limits above, so the search is partial. */
  more: boolean
}

type Installation = { accountLogin: string; repositories: { fullName: string }[] | null }

function canonical(values: string[], max: number): { kept: string[]; more: boolean } {
  const byKey = new Map<string, string>()
  for (const value of values) {
    const key = value.toLowerCase()
    if (!byKey.has(key)) {
      byKey.set(key, value)
    }
  }
  const sorted = [...byKey.keys()].sort().map((key) => byKey.get(key) ?? key)
  return { kept: sorted.slice(0, max), more: sorted.length > max }
}

export function gitHubPeopleScope(installations: readonly Installation[]): GitHubPeopleScope {
  const repositories: string[] = []
  const owners: string[] = []
  for (const install of installations) {
    if (install.repositories === null) {
      owners.push(install.accountLogin)
    } else {
      repositories.push(...install.repositories.map((repo) => repo.fullName))
    }
  }
  const repos = canonical(repositories, GITHUB_PEOPLE_MAX_REPOSITORIES)
  const accounts = canonical(owners, GITHUB_PEOPLE_MAX_OWNERS)
  return { repositories: repos.kept, owners: accounts.kept, more: repos.more || accounts.more }
}
