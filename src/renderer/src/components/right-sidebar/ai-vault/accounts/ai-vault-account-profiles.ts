export function profileDirectory(frame: unknown): Map<string, string> {
  const profiles = new Map<string, string>()
  if (typeof frame !== 'object' || frame === null || !('snapshot' in frame)) {
    return profiles
  }
  const snapshot = frame.snapshot
  if (typeof snapshot !== 'object' || snapshot === null || !('opencode' in snapshot)) {
    return profiles
  }
  const data = snapshot.opencode
  if (
    typeof data !== 'object' ||
    data === null ||
    !('accounts' in data) ||
    !Array.isArray(data.accounts)
  ) {
    return profiles
  }
  for (const account of data.accounts) {
    if (
      typeof account !== 'object' ||
      account === null ||
      typeof account.id !== 'string' ||
      typeof account.label !== 'string' ||
      !account.id ||
      !account.label
    ) {
      return new Map()
    }
    if (!profiles.has(account.id)) {
      profiles.set(account.id, account.label)
    }
  }
  return profiles
}
