// Why: publishing an artifact mints a URL anyone can open, so agents get the capability only
// after the user grants it. The gate lives here so main, the CLI, and Settings share one contract.
import type { GlobalSettings } from './global-settings-types'

export const ARTIFACT_SHARING_DISABLED_CODE = 'artifact_sharing_disabled'

// Why device-wide wording: the gate has no caller identity, so `orca artifacts share` typed by a
// human is denied exactly like an agent's. Copy that blames agents alone would misdescribe it.
export const ARTIFACT_SHARING_DISABLED_MESSAGE =
  'Publishing artifacts is off for this device. Nothing running here — agents or the orca CLI — can mint public artifact links until you allow it.'

export const ARTIFACT_SHARING_DISABLED_NEXT_STEPS: readonly string[] = [
  'Open Settings → Artifacts in the Orca desktop app on this device.',
  'Turn on "Allow publishing public artifact links".',
  'Run the share command again.'
]

export class ArtifactSharingDisabledError extends Error {
  readonly code = ARTIFACT_SHARING_DISABLED_CODE
  readonly data = { nextSteps: [...ARTIFACT_SHARING_DISABLED_NEXT_STEPS] }

  constructor() {
    super(ARTIFACT_SHARING_DISABLED_MESSAGE)
    this.name = 'ArtifactSharingDisabledError'
  }
}

/** Absent or non-`true` denies: an unmigrated profile must not inherit the capability. */
export function isArtifactSharingEnabled(
  settings: Pick<GlobalSettings, 'artifactSharingEnabled'> | null | undefined
): boolean {
  return settings?.artifactSharingEnabled === true
}

export function assertArtifactSharingAllowed(isEnabled: () => boolean): void {
  if (!isEnabled()) {
    throw new ArtifactSharingDisabledError()
  }
}
