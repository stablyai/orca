import type { ExecutionHostId } from './execution-host'

/**
 * What a bounded listing did and did not cover, by execution host. An absent scope means the
 * host is too old to report one — not that it covered everything. See
 * `docs/reference/ssh-execution-boundary.md`: a listing is only evidence about the hosts it
 * actually covered, so an empty answer for a host that is missing here proves nothing.
 */
export type RuntimeListingHostScope = {
  hostIds: ExecutionHostId[]
  omittedHostIds: ExecutionHostId[]
}
