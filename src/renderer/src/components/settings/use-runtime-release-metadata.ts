// Why: lazily fetches the SERVER's electron-updater release manifest only while
// the update advisor is shown for a `server-too-old` block — never on the compat
// gate or the polled status path. The fetch is routed through main (renderer
// fetch() would hit CORS on GitHub's release-asset redirect); parsing and
// derivation reuse the shared, dependency-free release-manifest module. Any
// failure yields undefined, so the advisor keeps its version-less guidance.

import { useEffect, useMemo, useState } from 'react'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  deriveReleaseMetadata,
  parseReleaseManifest,
  type ParsedReleaseManifest,
  type ReleaseMetadata
} from '../../../../shared/runtime-release-manifest'
import type { RuntimeUpdateGuideArch } from '../../../../shared/runtime-update-guide-templates'
import { validateRuntimeUpdateInfo } from '../../../../shared/runtime-update-info-validation'

// Staleness only affects advice text, never compatibility, so a short in-memory
// cache keyed by platform/arch avoids re-fetching across advisor mounts.
const CACHE_TTL_MS = 5 * 60 * 1000
type CacheEntry = { at: number; manifest: ParsedReleaseManifest }
const manifestCache = new Map<string, CacheEntry>()

async function loadReleaseManifest(
  platform: string | undefined,
  arch: RuntimeUpdateGuideArch | undefined
): Promise<ParsedReleaseManifest | null> {
  const key = `${platform ?? ''}:${arch ?? ''}`
  const cached = manifestCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.manifest
  }
  const result = await window.api.runtimeReleaseManifest.fetch({ platform, arch })
  if (!result.ok) {
    return null
  }
  const manifest = parseReleaseManifest(result.yaml)
  if (!manifest) {
    return null
  }
  manifestCache.set(key, { at: Date.now(), manifest })
  return manifest
}

/**
 * Release metadata for the blocked server, or undefined while pending, on
 * failure, or when the verdict is not `server-too-old`. Manifest values
 * (latestVersion/updateAvailable/assetUrl) override any server-supplied hints
 * downstream in the advisor model.
 */
export function useRuntimeReleaseMetadata(
  verdict: RuntimeCompatVerdict,
  status: RuntimeStatus
): ReleaseMetadata | undefined {
  const isServerTooOld = verdict.kind === 'blocked' && verdict.reason === 'server-too-old'
  const validated = useMemo(() => validateRuntimeUpdateInfo(status.updateInfo), [status.updateInfo])
  const platform = status.hostPlatform
  const arch = validated.hostArch
  const [manifest, setManifest] = useState<ParsedReleaseManifest | null>(null)

  useEffect(() => {
    if (!isServerTooOld) {
      setManifest(null)
      return
    }
    let cancelled = false
    void loadReleaseManifest(platform, arch).then((loaded) => {
      if (!cancelled) {
        setManifest(loaded)
      }
    })
    return () => {
      cancelled = true
    }
  }, [isServerTooOld, platform, arch])

  return useMemo(() => {
    if (!manifest) {
      return undefined
    }
    return deriveReleaseMetadata({
      manifest,
      currentVersion: validated.currentVersion,
      installKind: validated.installKind,
      arch
    })
  }, [manifest, validated.currentVersion, validated.installKind, arch])
}
