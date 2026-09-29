/** Last capped local listing; name filters re-list such workspaces on the host. */
export type CappedLocalListing = { key: string; hostFilterFailed: boolean }

export function nextCappedLocalListing(
  current: CappedLocalListing | null,
  key: string,
  truncated: boolean
): CappedLocalListing | null {
  // Why: a failed host filter stays failed so re-listing the same workspace does not retry it.
  return truncated
    ? { key, hostFilterFailed: current?.key === key && current.hostFilterFailed }
    : null
}
