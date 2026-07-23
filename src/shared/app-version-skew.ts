// Why: protocol-version compat (protocol-compat.ts) only blocks truly
// incompatible pairs. App-version skew between a desktop client and a remote
// `orca serve` host is still worth a non-blocking warning: a client that
// auto-updated ahead of its server can hit missing-RPC failures with
// misleading downstream errors (e.g. "could not launch claude in a new
// terminal") when the real fix is updating the server.

export type AppVersionSkewDirection = 'server-older' | 'server-newer'

export type AppVersionSkew = {
  direction: AppVersionSkewDirection
  clientAppVersion: string
  /** null when the server predates app-version reporting in status.get. */
  serverAppVersion: string | null
}

type ParsedAppVersion = {
  release: [number, number, number]
  prerelease: string[] | null
}

// Why: hand-rolled instead of the semver package so the evaluator stays
// dependency-free and safe to mirror in the Expo mobile build.
export function parseAppVersion(version: string | null | undefined): ParsedAppVersion | null {
  const trimmed = version?.trim()
  if (!trimmed) {
    return null
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed)
  if (!match) {
    return null
  }
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : null
  }
}

function comparePrereleaseIds(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) {
    return Number(a) - Number(b)
  }
  // Why: semver rule — numeric identifiers sort below alphanumeric ones.
  if (aNumeric !== bNumeric) {
    return aNumeric ? -1 : 1
  }
  return a < b ? -1 : a > b ? 1 : 0
}

export function compareAppVersions(a: ParsedAppVersion, b: ParsedAppVersion): number {
  for (let i = 0; i < 3; i++) {
    const diff = a.release[i]! - b.release[i]!
    if (diff !== 0) {
      return diff
    }
  }
  // Why: a release (no prerelease) outranks any rc of the same triple.
  if (!a.prerelease && !b.prerelease) {
    return 0
  }
  if (!a.prerelease || !b.prerelease) {
    return a.prerelease ? -1 : 1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i++) {
    const aId = a.prerelease[i]
    const bId = b.prerelease[i]
    if (aId === undefined || bId === undefined) {
      return aId === undefined ? -1 : 1
    }
    const diff = comparePrereleaseIds(aId, bId)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

export function evaluateAppVersionSkew(input: {
  clientAppVersion: string | null | undefined
  serverAppVersion: string | null | undefined
}): AppVersionSkew | null {
  const client = parseAppVersion(input.clientAppVersion)
  if (!client) {
    return null
  }
  const reportedServerVersion = input.serverAppVersion?.trim()
  if (!reportedServerVersion) {
    // Why: every server that reports a live status but no appVersion predates
    // this feature, so it is provably older than any client evaluating it.
    return {
      direction: 'server-older',
      clientAppVersion: input.clientAppVersion!.trim(),
      serverAppVersion: null
    }
  }
  const server = parseAppVersion(reportedServerVersion)
  if (!server) {
    // Why: a reported-but-unparseable version (custom build) proves nothing
    // about age, so stay silent rather than mislabeling it as older.
    return null
  }
  const diff = compareAppVersions(server, client)
  if (diff === 0) {
    return null
  }
  return {
    direction: diff < 0 ? 'server-older' : 'server-newer',
    clientAppVersion: input.clientAppVersion!.trim(),
    serverAppVersion: input.serverAppVersion!.trim()
  }
}

export function describeAppVersionSkew(skew: AppVersionSkew): string {
  if (skew.direction === 'server-older') {
    return skew.serverAppVersion
      ? `This Orca server (${skew.serverAppVersion}) is older than your app (${skew.clientAppVersion}). Update the server, or some features may fail.`
      : `This Orca server is older than your app (${skew.clientAppVersion}). Update the server, or some features may fail.`
  }
  return `This Orca server (${skew.serverAppVersion}) is newer than your app (${skew.clientAppVersion}). Update this app, or some features may fail.`
}
