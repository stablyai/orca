export type SkillBundleFileIdentity = {
  path: string
  size: number
  executable: boolean
  classification: 'text' | 'binary'
  exactSha256: string
  textNormalizedSha256: string | null
  identitySha256: string
}

const ORCA_SKILL_LOCK_SOURCE = 'stablyai/orca'

/** Whether the skills.sh lock says this name was installed from Orca's repository. */
export function isOrcaSkillLockSource(source: string | null): boolean {
  if (!source) {
    return false
  }
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  return normalized === ORCA_SKILL_LOCK_SOURCE
}

/** Why an install leaves a location as it is. Each maps to one plain sentence. */
export type BundledSkillLeaveReason =
  | 'local-changes'
  | 'not-installed-by-orca'
  | 'link-not-managed'
  | 'name-in-use'
  | 'read-only'
  | 'unreadable'

export type BundledSkillLocationAction =
  | 'keep'
  /** Writes the shared copy where none exists. */
  | 'install'
  /** Rewrites a shared copy Orca installed. */
  | 'update'
  /** Points an agent's skills folder at the shared copy. */
  | 'link'
  /** Rewrites an Orca-installed copy in an agent's skills folder. */
  | 'replace'
  | 'leave'

export type BundledSkillLocationPlan = {
  path: string
  /** `shared` is the .agents/skills copy agent folders link to. */
  role: 'shared' | 'agent'
  action: BundledSkillLocationAction
  /** Whether something is at this path now. */
  exists: boolean
  reason?: BundledSkillLeaveReason
}

/** What installing one of Orca's own skills does on a host, read without writing. */
export type BundledSkillPlan = {
  name: string
  /** This build's package; a nudge dismissal is scoped to it. */
  packageDigest: string
  locations: BundledSkillLocationPlan[]
}

export type BundledSkillVerdict =
  /** Nothing of this skill is here. */
  | 'absent'
  | 'current'
  /** An Orca-installed copy is here and the install would rewrite something. */
  | 'update'
  /** A copy is here that the install leaves as it is, and nothing Orca's to update. */
  | 'attention'

const WRITES: ReadonlySet<BundledSkillLocationAction> = new Set([
  'install',
  'update',
  'link',
  'replace'
])

export function bundledSkillPlanWrites(plan: BundledSkillPlan): boolean {
  return plan.locations.some((location) => WRITES.has(location.action))
}

export function bundledSkillLeftLocations(plan: BundledSkillPlan): BundledSkillLocationPlan[] {
  return plan.locations.filter((location) => location.action === 'leave')
}

/**
 * The one reading of a plan every surface shares: the CLI's update, the app's badge,
 * nudge and Update skills dialog. An update only rewrites skills Orca already has a copy
 * of here; `install` is the verb that adds one.
 */
export function bundledSkillVerdict(plan: BundledSkillPlan): BundledSkillVerdict {
  if (!plan.locations.some((location) => location.exists)) {
    return 'absent'
  }
  const hasOrcaCopy = plan.locations.some(
    (location) =>
      location.exists &&
      (location.action === 'keep' || location.action === 'update' || location.action === 'replace')
  )
  if (hasOrcaCopy && bundledSkillPlanWrites(plan)) {
    return 'update'
  }
  return bundledSkillLeftLocations(plan).length > 0 ? 'attention' : 'current'
}

/** This host's plan for every Orca skill that has any copy here. */
export type SkillFreshnessInventory = {
  schemaVersion: 2
  skills: BundledSkillPlan[]
  scannedAt: number
}

export function canonicalizeSkillUpdateNames(names: readonly string[]): string[] | null {
  const canonicalNames = [...new Set(names)].sort((left, right) => left.localeCompare(right, 'en'))
  // Why: names reach a shell in the copied fallback command. Official manifests use
  // this restricted package-name grammar so no entry can introduce shell syntax.
  if (canonicalNames.some((name) => !/^[a-z0-9][a-z0-9._-]*$/.test(name))) {
    return null
  }
  return canonicalNames.length > 0 ? canonicalNames : null
}

// Why one indeterminate phase: per-skill outcomes come from re-planning after the run,
// which is what the dialog reports on.
export type SkillUpdateRun =
  | { state: 'idle' }
  // `stopping` covers the window between Stop and the install actually settling — the run is
  // still `running` (that is what blocks a second writer), but Stop has already been spent.
  | { state: 'running'; names: string[]; startedAt: number; output: string; stopping?: boolean }
  | { state: 'success'; names: string[]; finishedAt: number; output: string }
  | {
      state: 'error'
      names: string[]
      finishedAt: number
      output: string
      message: string
      /** Names the re-plan after the run still has work for. */
      failedNames: string[]
    }

export type SkillUpdateStartResult =
  | { started: true }
  | { started: false; reason: 'already-running' | 'invalid-names' }
