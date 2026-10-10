import { runProcess, runProcessSync } from './child-process/run-process'
import { windowsSystem32Binary } from './child-process/windows-system-binary'
const ACL_TIMEOUT_MS = 5000
const WINDOWS_SID_PATTERN = /^S-1-\d+(?:-\d+)+$/
let cachedWindowsUserSid: string | null = null
let sidLookupFailedAt: number | null = null
const SID_LOOKUP_RETRY_MS = 60_000

/**
 * Why monotonic and not `Date.now`: a backwards wall-clock step held this window open until the
 * clock caught up, and this latch is worse than the read-path budget's — a failed lookup makes
 * `planFor` return null, which disables the synchronous *write* path too, so the write-path
 * exemption that recovers from that one cannot recover from this.
 */
const monotonicNowMs = (): number => performance.now()

/**
 * Only a well-formed SID is cached for the process lifetime. A failure is cached for a minute:
 * caching it forever let one transient `whoami` hiccup disable hardening until restart.
 */
export function getCurrentWindowsUserSid(): string | null {
  if (cachedWindowsUserSid) {
    return cachedWindowsUserSid
  }
  if (sidLookupFailedAt !== null && monotonicNowMs() - sidLookupFailedAt < SID_LOOKUP_RETRY_MS) {
    return null
  }
  try {
    const result = runProcessSync({
      program: windowsSystem32Binary('whoami.exe'),
      args: ['/user', '/fo', 'csv', '/nh'],
      timeoutMs: ACL_TIMEOUT_MS
    })
    const candidate = result.code === 0 ? parseCsvLine(result.stdout.trim())[1] : undefined
    if (candidate && WINDOWS_SID_PATTERN.test(candidate)) {
      cachedWindowsUserSid = candidate
      sidLookupFailedAt = null
      return candidate
    }
  } catch {
    // Fall through to the failure record below.
  }
  sidLookupFailedAt = monotonicNowMs()
  return null
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}

export function resetSecureFileWindowsUserSidForTests(): void {
  cachedWindowsUserSid = null
  sidLookupFailedAt = null
}

export async function getCurrentWindowsUserSidAsync(options: {
  timeoutMs: number
  signal?: AbortSignal
}): Promise<string | null> {
  if (cachedWindowsUserSid) {
    return cachedWindowsUserSid
  }
  const result = await runProcess({
    program: windowsSystem32Binary('whoami.exe'),
    args: ['/user', '/fo', 'csv', '/nh'],
    ...options
  })
  const candidate =
    result.code === 0 && !result.timedOut && !result.outputTruncated && !options.signal?.aborted
      ? parseCsvLine(result.stdout.trim())[1]
      : undefined
  if (!candidate || !WINDOWS_SID_PATTERN.test(candidate)) {
    return null
  }
  cachedWindowsUserSid = candidate
  sidLookupFailedAt = null
  return candidate
}
