import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'

export type AccountMenuIdentity =
  | { signedIn: false; needsReconnect: boolean }
  | { signedIn: true; initial: string; name: string; email: string }

export function getAccountMenuIdentity(
  authStatus: OrcaProfileAuthStatus | null
): AccountMenuIdentity {
  const cloud = authStatus?.cloud
  if (authStatus?.state !== 'connected' || !cloud) {
    return { signedIn: false, needsReconnect: authStatus?.state === 'reconnect-required' }
  }
  const name = cloud.displayName?.trim() || cloud.email
  // Array.from keeps a leading astral character (e.g. emoji) whole instead of half a surrogate pair.
  const initial = (Array.from(name.trim())[0] ?? '?').toLocaleUpperCase()
  return { signedIn: true, initial, name, email: cloud.email }
}
