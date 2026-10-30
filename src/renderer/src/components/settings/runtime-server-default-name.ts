import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import { findCollidingEnvironmentName } from '../../../../shared/runtime-environment-name-collision'

/** Choose host, host:port, then numbered suffixes so servers sharing a machine/address still get unique blank-name defaults. */
export function defaultServerNameForAccessLink(
  accessLink: string,
  existing: readonly { name: string }[] = []
): string {
  const parsed = parseHostAccessLink(accessLink)
  if (!parsed.ok) {
    return ''
  }
  const endpoint = parsed.value.displayEndpoint
  let host = endpoint
  try {
    host = new URL(`ws://${endpoint}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    // Not URL-shaped; the endpoint itself is the best name.
  }
  for (const candidate of host === endpoint ? [host] : [host, endpoint]) {
    if (!findCollidingEnvironmentName(existing, candidate)) {
      return candidate
    }
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${host} (${suffix})`
    if (!findCollidingEnvironmentName(existing, candidate)) {
      return candidate
    }
  }
}
