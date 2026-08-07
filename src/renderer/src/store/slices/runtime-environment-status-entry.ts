import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { evaluateAppVersionSkew, type AppVersionSkew } from '../../../../shared/app-version-skew'
import { getClientAppVersion } from '@/runtime/client-app-version'

/** Live status for one saved runtime environment, as last observed by the
 * renderer. `status === null` records a probe that failed or timed out so the
 * sidebar can still distinguish "unknown/unreachable" from "never checked". */
export type RuntimeEnvironmentStatus = {
  status: RuntimeStatus | null
  appVersion?: string | null
  /** Non-blocking client/server app-version skew; null when versions match,
   * the server is unreachable, or this build's version is unknown. */
  versionSkew?: AppVersionSkew | null
  checkedAt: number
  connectionGeneration?: number
}

// Why: skew detection is best-effort decoration — a stalled version IPC must
// never delay or block publishing a live server status.
const CLIENT_APP_VERSION_TIMEOUT_MS = 2_000

async function getClientAppVersionBounded(): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      getClientAppVersion(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CLIENT_APP_VERSION_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Builds a store entry from one probe result, deriving app-version skew
 * against this build. Shared by the boot/refresh probes and the host menu's
 * manual "Check connection" so no ingestion path drops the skew verdict. */
export async function buildRuntimeEnvironmentStatusEntry(
  status: RuntimeStatus | null
): Promise<RuntimeEnvironmentStatus> {
  // Why: stamp before the version lookup so checkedAt reflects when the server
  // answered, not when the (possibly first-call) version IPC resolved.
  const checkedAt = Date.now()
  if (!status) {
    return { status: null, checkedAt }
  }
  const clientAppVersion = await getClientAppVersionBounded()
  return {
    status,
    appVersion: status.appVersion ?? null,
    versionSkew: evaluateAppVersionSkew({
      clientAppVersion,
      serverAppVersion: status.appVersion ?? null
    }),
    checkedAt
  }
}
