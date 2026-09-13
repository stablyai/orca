import { runProcess, runProcessSync, type ProcessResult } from './child-process/run-process'
import { windowsSystem32Binary } from './child-process/windows-system-binary'

const WHOAMI_SID_ARGS = ['/user', '/fo', 'csv', '/nh'] as const
const WHOAMI_TIMEOUT_MS = 5000
const SID_LOOKUP_RETRY_MS = 60_000
const WINDOWS_SID_PATTERN = /^S-1-\d+(?:-\d+)+$/

let cachedWindowsUserSid: string | null = null
let sidLookupFailedAt: number | null = null
let pendingSidLookup: Promise<string | null> | null = null

/**
 * Why monotonic and not `Date.now`: a backwards wall-clock step held this window open until the
 * clock caught up, and this latch is worse than the read-path budget's — a failed lookup makes
 * the caller's ACL plan unbuildable, which disables the synchronous *write* path too, so the
 * write-path exemption that recovers from that one cannot recover from this.
 */
const monotonicNowMs = (): number => performance.now()

/** null when there is no cached answer and a lookup must run; otherwise the answer to return. */
function cachedSidOutcome(): { sid: string | null } | null {
  if (cachedWindowsUserSid) {
    return { sid: cachedWindowsUserSid }
  }
  if (sidLookupFailedAt !== null && monotonicNowMs() - sidLookupFailedAt < SID_LOOKUP_RETRY_MS) {
    return { sid: null }
  }
  return null
}

/**
 * Only a well-formed SID is cached for the process lifetime. A failure is cached for a minute:
 * caching it forever let one transient `whoami` hiccup disable hardening until restart.
 */
function acceptSidLookup(result: ProcessResult | null): string | null {
  const candidate = result?.code === 0 ? parseCsvLine(result.stdout.trim())[1] : undefined
  if (candidate && WINDOWS_SID_PATTERN.test(candidate)) {
    cachedWindowsUserSid = candidate
    sidLookupFailedAt = null
    return candidate
  }
  sidLookupFailedAt = monotonicNowMs()
  return null
}

/** The default for every IPC-reachable caller; single-flight so concurrent ones share one spawn. */
export async function getCurrentWindowsUserSidAsync(): Promise<string | null> {
  const cached = cachedSidOutcome()
  if (cached) {
    return cached.sid
  }
  return (pendingSidLookup ??= (async () => {
    try {
      return acceptSidLookup(
        await runProcess({
          program: windowsSystem32Binary('whoami.exe'),
          args: WHOAMI_SID_ARGS,
          timeoutMs: WHOAMI_TIMEOUT_MS
        })
      )
    } catch {
      return acceptSidLookup(null)
    }
  })().finally(() => {
    pendingSidLookup = null
  }))
}

export function getCurrentWindowsUserSid(): string | null {
  const cached = cachedSidOutcome()
  if (cached) {
    return cached.sid
  }
  try {
    // Why sync: only the credential-write lane reaches this, and it must not publish the file
    // before its ACL is applied. The async lane populates the same cache for it.
    return acceptSidLookup(
      runProcessSync({
        program: windowsSystem32Binary('whoami.exe'),
        args: WHOAMI_SID_ARGS,
        timeoutMs: WHOAMI_TIMEOUT_MS
      })
    )
  } catch {
    return acceptSidLookup(null)
  }
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}

export function resetSecureFileWindowsUserSidForTests(): void {
  cachedWindowsUserSid = null
  sidLookupFailedAt = null
  pendingSidLookup = null
}
