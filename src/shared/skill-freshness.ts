import type { SkillProvider, SkillSourceKind } from './skills'

export type SkillBundleFileIdentity = {
  path: string
  size: number
  executable: boolean
  classification: 'text' | 'binary'
  exactSha256: string
  textNormalizedSha256: string | null
  identitySha256: string
}

export type SkillKnownSnapshot = {
  releaseRevision: number
  packageDigest: string
  gitTreeSha: string
  files: SkillBundleFileIdentity[]
}

export type SkillCurrentBundleEntry = SkillKnownSnapshot & {
  name: string
  sourcePath: string
}

// Why: schema 2 removed the stamped app version so the committed artifact is a
// pure function of skills/ content; the running build supplies its own version.
export type SkillBundleManifest = {
  schemaVersion: 2
  skills: SkillCurrentBundleEntry[]
}

export type SkillSnapshotRegistry = {
  schemaVersion: 1
  skills: Record<string, SkillKnownSnapshot[]>
}

export type SkillReleaseMapping = {
  schemaVersion: 1
  releases: { appVersion: string; skills: Record<string, number> }[]
}

export type SkillFreshnessStatus =
  | 'current'
  | 'outdated'
  | 'newer-known'
  | 'unrecognized'
  | 'inaccessible'

export type SkillInstallationTopology =
  | 'canonical-copy'
  | 'provider-alias'
  | 'independent-copy'
  | 'external-link'
  | 'broken-link'
  | 'read-only'
  | 'repo-scope'
  | 'plugin-cache'

// Why: eligibility and the explanation copy must agree on which placements the
// validated npx rail can converge; a drifted copy would blame a phantom sibling.
export const SUPPORTED_GLOBAL_SKILL_TOPOLOGIES: ReadonlySet<SkillInstallationTopology> = new Set([
  'canonical-copy',
  'provider-alias'
])

export type SkillFreshnessInstallation = {
  id: string
  name: string
  rootId: string
  providers: SkillProvider[]
  sourceKind: SkillSourceKind
  sourceLabel: string
  unresolvedPath: string
  resolvedPath: string | null
  physicalIdentity: string | null
  topology: SkillInstallationTopology
  status: SkillFreshnessStatus
  installedReleaseRevision: number | null
  installedAppVersion: string | null
  currentReleaseRevision: number
  currentPackageDigest: string
  currentAppVersion: string
  observedPackageDigest: string | null
  /** Git tree sha of the observed bytes; lets the post-run verdict match disk against the updater's lock. */
  observedGitTreeSha?: string | null
  errorCategory: string | null
}

/**
 * Whether a copy is wrong in a way running the update would not resolve.
 *
 * Shared so the badge and the review dialog cannot disagree about what counts: the
 * badge points at the dialog for the explanation, so a copy that turns the badge
 * amber must also produce a row there. An out-of-date copy the command converges is
 * ordinary work, not a problem, and a plugin's own copy of a same-named skill is the
 * vendor's business rather than the user's drift.
 */
export function isSkillCopyNeedingAttention(installation: SkillFreshnessInstallation): boolean {
  return (
    installation.status !== 'current' &&
    !(installation.status === 'unrecognized' && installation.topology === 'plugin-cache') &&
    !(
      SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(installation.topology) &&
      installation.status === 'outdated'
    )
  )
}

export type SkillFreshnessScanIssueReason =
  | 'depth-limit'
  | 'entry-limit'
  | 'candidate-limit'
  | 'manifest-limit'
  | 'outside-root'
  | 'io-error'
  | 'issue-limit'

export type SkillFreshnessScanIssue = {
  rootId: string
  sourceLabel: string
  path: string
  reason: SkillFreshnessScanIssueReason
  errorCode: string | null
}

// Why: a real read failure is a fact about the user's disk and stays actionable. Orca's
// own traversal bounds are not — reporting them as attention turns an ordinary large
// plugin cache into a permanent amber pill on every skill.
//
// 'outside-root' is deliberately NOT here. A plugin that links its skills out of the
// cache (a content-addressed store, a dev-linked package) is a packaging choice by the
// vendor, not a fault the user can clear: deleting the link only makes their package
// manager recreate it. Flagging it turned an install that is clean on main into amber on
// every installed skill. It is still listed in Details, like the other bounds.
const SKILL_SCAN_ATTENTION_REASONS = new Set<SkillFreshnessScanIssueReason>(['io-error'])

export function isSkillScanAttentionReason(reason: SkillFreshnessScanIssueReason): boolean {
  return SKILL_SCAN_ATTENTION_REASONS.has(reason)
}

export function isSkillScanIssueNeedingAttention(issue: SkillFreshnessScanIssue): boolean {
  return isSkillScanAttentionReason(issue.reason)
}

// Why: these are the bounds that end the walk rather than skip one folder. They are
// still not the user's to act on, so they raise no pill — but a scan that stopped
// early cannot be reported as proof every copy is up to date.
const SKILL_SCAN_TRUNCATING_REASONS = new Set<SkillFreshnessScanIssueReason>([
  'entry-limit',
  'candidate-limit'
])

export function isTruncatingSkillScanReason(reason: SkillFreshnessScanIssueReason): boolean {
  return SKILL_SCAN_TRUNCATING_REASONS.has(reason)
}

export function isSkillScanIssueTruncatingScan(issue: SkillFreshnessScanIssue): boolean {
  return isTruncatingSkillScanReason(issue.reason)
}

export type SkillFreshnessInventory = {
  schemaVersion: 1
  installations: SkillFreshnessInstallation[]
  eligibleUpdateNames: string[]
  scanIssues: SkillFreshnessScanIssue[]
  scannedAt: number
}

export function canonicalizeSkillUpdateNames(names: readonly string[]): string[] | null {
  const canonicalNames = [...new Set(names)].sort((left, right) => left.localeCompare(right, 'en'))
  // Why: names reach a shell in the terminal fallback. Official manifests use
  // this restricted package-name grammar so no entry can introduce shell syntax.
  if (canonicalNames.some((name) => !/^[a-z0-9][a-z0-9._-]*$/.test(name))) {
    return null
  }
  return canonicalNames.length > 0 ? canonicalNames : null
}

export function buildTargetedSkillUpdateCommand(names: readonly string[]): string | null {
  const canonicalNames = canonicalizeSkillUpdateNames(names)
  return canonicalNames ? `npx skills update ${canonicalNames.join(' ')} --global` : null
}

// Why: `skills update` has no --json (that flag only exists on `list`), so the
// run reports one indeterminate phase. Per-skill outcomes come from re-scanning
// the inventory after exit, never from parsing stdout.
export type SkillUpdateRun =
  | { state: 'idle' }
  // `stopping` covers the window between Stop and the process tree actually
  // dying — the run is still `running` (that is what blocks a second writer),
  // but the Stop affordance has already been spent.
  | { state: 'running'; names: string[]; startedAt: number; output: string; stopping?: boolean }
  | { state: 'success'; names: string[]; finishedAt: number; output: string }
  | {
      state: 'error'
      names: string[]
      finishedAt: number
      output: string
      message: string
      /** Names still outdated after the run — the re-scan is the source of truth. */
      failedNames: string[]
    }

export type SkillUpdateStartResult =
  | { started: true }
  | { started: false; reason: 'already-running' | 'invalid-names' | 'unsafe-command-path' }
