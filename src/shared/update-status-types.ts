import type { DedicatedRepoChannel, ReleaseBuild, ReleaseChannel } from './release-channel'

// Keep version only on UpdateStatus so release payloads cannot disagree.
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

/** Derive nonrelease origins from dev channels so new dedicated repos cannot be mislabeled ordinary releases. */
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

export type UpdateInstallBlocker = {
  pid: number
  kind: 'window' | 'server' | 'browser' | 'unknown'
}

export type UpdateInstallBlock = {
  reason: 'running-instances' | 'busy' | 'unresponsive'
  instances: UpdateInstallBlocker[]
}

export type UpdateStatus = (
  | { state: 'idle' }
  | { state: 'checking'; userInitiated?: boolean }
  | {
      state: 'available'
      version: string
      activeNudgeId?: string
      // Kept for Settings release-link fallback; the current update-available handler does not populate it.
      releaseUrl?: string
      // Main always sets this: null means fetch failure/missing version, object enables rich mode. Avoid an undefined third state.
      changelog: ChangelogData | null
      /** Linux only: a package manager owns this install, so Orca cannot apply the update itself.
       *  Additive and optional — older clients simply keep offering their own download. */
      externallyManaged?: boolean
    }
  | { state: 'not-available'; userInitiated?: boolean }
  | { state: 'downloading'; percent: number; version: string; activeNudgeId?: string }
  | {
      state: 'downloaded'
      version: string
      releaseUrl?: string
      activeNudgeId?: string
      /** Install preparation is in progress; older clients can still render downloaded. */
      installing?: boolean
    }
  | {
      state: 'error'
      message: string
      /** Known download/install target; absent for check-time failures and older hosts. */
      version?: string
      /** Omitted by older hosts and for failures whose retryability is unknown. */
      retryable?: boolean
      /** A staged update can retry installation without downloading again; older hosts omit this. */
      retryAction?: 'install'
      userInitiated?: boolean
      activeNudgeId?: string
      recovery?: LinuxPackageInstallRecovery
      /** Optional so older paired clients retain the diagnostic and install retry. */
      installBlock?: UpdateInstallBlock
    }
) & { source?: UpdateSource }

export type ReleaseBuildListResult =
  | { ok: true; channel: ReleaseChannel; builds: ReleaseBuild[] }
  | { ok: false; channel: ReleaseChannel; message: string }
