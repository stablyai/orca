declare const hostScopedRepoKeyBrand: unique symbol

// Why: for new code only; existing raw-id stores stay as they are (D7).
export type HostScopedRepoKey = string & { readonly [hostScopedRepoKeyBrand]: true }

export function getRepoHostIdentityForParts(repoId: string, hostId: string): HostScopedRepoKey {
  // Why: host ids and repo ids can contain punctuation; NUL keeps the composite
  // key collision-free without escaping user/provider-owned strings.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is the only constructor of the brand; the bytes are the unbranded composite, frozen by golden tests (D25).
  return `${hostId}\0${repoId}` as HostScopedRepoKey
}
