import type { DedicatedRepoChannel, ReleaseBuild, ReleaseChannel } from './release-channel'

// ─── Updater ─────────────────────────────────────────────────────────

// Why: the release object sent to the renderer omits `version` (redundant
// with the top-level UpdateStatus.version) to keep one source of truth.
export type ChangelogRelease = {
  title: string
  description: string
  mediaUrl?: string
  releaseNotesUrl: string
}

export type ChangelogData = {
  release: ChangelogRelease
  releasesBehind: number | null
}

export type UpdateCheckOptions = {
  includePrerelease?: boolean
  includePerfPrerelease?: boolean
  localBuild?: boolean
  /** Dev channel switching; `targetTag` pins an exact build, including older ones. */
  channel?: ReleaseChannel
  targetTag?: string
}

/** Non-release origins for an update. Derived from the dev-channel list so a new
 *  channel with its own repo cannot be reported as an ordinary release. */
export type UpdateSource = 'local' | DedicatedRepoChannel

/** Root-package Linux install formats whose update installs need privilege escalation. */
export type LinuxRootPackageType = 'deb' | 'rpm'

export type LinuxPackageInstallFailureReason =
  | 'authentication-agent-unavailable'
  | 'authentication-denied'
  | 'package-install-failed'

export type LinuxPackageInstallRecoveryReason =
  | 'manual-install-required'
  | LinuxPackageInstallFailureReason

// Older paired hosts can still publish classified install failures; the manual reason is additive.
export type LinuxPackageInstallRecovery = {
  kind: 'linux-package-install'
  packageType: LinuxRootPackageType
  reason: LinuxPackageInstallRecoveryReason
  version: string
}

/** Why: only these two mean no safe command exists here; every other failure clears recovery entirely. */
export type LinuxPackageCommandUnavailableReason = 'no-sudo' | 'no-package-manager'

export type LinuxPackageInstallInstructions =
  | { ok: true; command: string; packageFileName: string }
  | { ok: false; reason: LinuxPackageCommandUnavailableReason; message: string }

export type UpdateStatus = (
  | { state: 'idle' }
  | { state: 'checking'; userInitiated?: boolean }
  | {
      state: 'available'
      version: string
      activeNudgeId?: string
      // Why: releaseUrl is not currently populated by the update-available handler
      // (it always sends undefined). Kept on the type for the Settings page's
      // release-notes link fallback and for potential future use if the main
      // process starts extracting release URLs from electron-updater metadata.
      releaseUrl?: string
      // Why: changelog is always explicitly set by the main process — null means
      // the fetch failed or the version wasn't in the JSON (simple mode), and a
      // populated object means rich mode. Using `| null` (not `?`) avoids a
      // three-state ambiguity (undefined vs null vs present) and makes exhaustive
      // checks straightforward.
      changelog: ChangelogData | null
      /** Linux only: a package manager owns this install, so Orca cannot apply the update itself.
       *  Additive and optional — older clients simply keep offering their own download. */
      externallyManaged?: boolean
    }
  | { state: 'not-available'; userInitiated?: boolean }
  | { state: 'downloading'; percent: number; version: string; activeNudgeId?: string }
  | { state: 'downloaded'; version: string; releaseUrl?: string; activeNudgeId?: string }
  | {
      state: 'error'
      message: string
      /** Known download/install target; absent for check-time failures and older hosts. */
      version?: string
      /** Omitted by older hosts and for failures whose retryability is unknown. */
      retryable?: boolean
      userInitiated?: boolean
      activeNudgeId?: string
      recovery?: LinuxPackageInstallRecovery
    }
) & { source?: UpdateSource }

export type ReleaseBuildListResult =
  | { ok: true; channel: ReleaseChannel; builds: ReleaseBuild[] }
  | { ok: false; channel: ReleaseChannel; message: string }
