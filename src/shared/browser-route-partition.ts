const BROWSER_ROUTE_PARTITION_RE = /^persist:orca-browser-v1-[a-f0-9]{64}$/

/** Partitions main derives for routed (SSH and remote-runtime) browser sessions. */
export function isBrowserRoutePartition(value: string): boolean {
  return BROWSER_ROUTE_PARTITION_RE.test(value)
}
