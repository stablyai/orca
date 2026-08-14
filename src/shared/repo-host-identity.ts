export function getRepoHostIdentityForParts(repoId: string, hostId: string): string {
  // Why: host ids and repo ids can contain punctuation; NUL keeps the composite
  // key collision-free without escaping user/provider-owned strings.
  return `${hostId}\0${repoId}`
}
