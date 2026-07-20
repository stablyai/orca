// Why: pure derivation of the advisor's view model from the compat verdict and
// the blocked server's status. Kept out of the React component so the
// verdict-branching logic (client-too-old renders no server commands) can be
// unit-tested without rendering, and so the trust boundary — always running raw
// `status.updateInfo` through the shared validator — lives in one place.

import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import type { ReleaseMetadata } from '../../../../shared/runtime-release-manifest'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  buildRuntimeUpdateGuide,
  type RuntimeUpdateGuide,
  type RuntimeUpdateGuideInput
} from '../../../../shared/runtime-update-guide'
import { validateRuntimeUpdateInfo } from '../../../../shared/runtime-update-info-validation'

export type RuntimeUpdateAdvisorModelInput = {
  verdict: RuntimeCompatVerdict
  status: RuntimeStatus
  /** Port from the client's own paired endpoint — a hint the guide falls back
   *  from when absent. Never sourced from server metadata. */
  portHint?: number
  /** Client-fetched release-manifest metadata. Wins over server-supplied
   *  latestVersion/updateAvailable (which are startup-stale hints), and is the
   *  only source of the exact deb/rpm asset URL. Absent while pending/failed. */
  releaseMetadata?: ReleaseMetadata
}

/**
 * Derive the guide-matrix input from the verdict + status. `status.updateInfo`
 * is untrusted server data, so it always passes through `validateRuntimeUpdateInfo`
 * before any field selects a template or fills a placeholder. `assetUrl` and the
 * winning latestVersion/updateAvailable come from the client-fetched manifest via
 * `input.releaseMetadata` when available.
 */
export function deriveRuntimeUpdateGuideInput(
  input: RuntimeUpdateAdvisorModelInput
): RuntimeUpdateGuideInput {
  const validated = validateRuntimeUpdateInfo(input.status.updateInfo)
  const release = input.releaseMetadata
  return {
    verdict: input.verdict,
    hostPlatform: input.status.hostPlatform,
    installKind: validated.installKind,
    restartKind: validated.restartKind,
    hostArch: validated.hostArch,
    serviceName: validated.serviceName,
    installPath: validated.installPath,
    currentVersion: validated.currentVersion,
    // Client-fetched manifest wins; fall back to the server's startup-stale hint
    // only when the manifest is pending or failed (`??` keeps a manifest `false`).
    latestVersion: release?.latestVersion ?? validated.latestVersion,
    updateAvailable: release?.updateAvailable ?? validated.updateAvailable,
    assetUrl: release?.assetUrl,
    docsUrl: validated.docsUrl,
    port: input.portHint
  }
}

/** null when the verdict is not a block: the advisor renders nothing. */
export function buildRuntimeUpdateAdvisorGuide(
  input: RuntimeUpdateAdvisorModelInput
): RuntimeUpdateGuide | null {
  return buildRuntimeUpdateGuide(deriveRuntimeUpdateGuideInput(input))
}

/**
 * Best-effort port hint parsed from the client-owned paired endpoint string
 * (e.g. `wss://host:6768/...`). Returns undefined when the endpoint carries no
 * explicit port or cannot be parsed, so the guide uses its documented default.
 */
export function parseEndpointPortHint(endpoint: string | undefined | null): number | undefined {
  if (!endpoint) {
    return undefined
  }
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return undefined
  }
  if (!parsed.port) {
    return undefined
  }
  const port = Number(parsed.port)
  return Number.isInteger(port) ? port : undefined
}
