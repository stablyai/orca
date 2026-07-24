// Why: version-skew evaluation needs this build's own app version wherever a
// remote runtime status is ingested. The IPC answer never changes within a
// session, so cache the promise instead of re-asking per status probe.
let cachedClientAppVersion: Promise<string | null> | null = null

export function getClientAppVersion(): Promise<string | null> {
  // Why: resolve inside the chain so a missing preload surface (minimal test
  // store assemblies) degrades to "unknown version" instead of throwing.
  cachedClientAppVersion ??= Promise.resolve()
    .then(() => window.api.updater.getVersion())
    .catch(() => {
      // Why: a rejected lookup must not poison the cache — clear it so the next
      // status ingestion retries instead of skipping skew detection all session.
      cachedClientAppVersion = null
      return null
    })
  return cachedClientAppVersion
}

export function resetClientAppVersionForTests(): void {
  cachedClientAppVersion = null
}
