// Which environment-check results stop an Orca Cloud create, and which only become a notice in the
// opened workspace. Peers (Conductor, Capy, Codex, Cursor) open the workspace and surface problems
// there; only a sandbox nobody can work in should hold the create on the build sheet.
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'

/** Failed checks that make the sandbox unusable: no checkout, no git, or orcad never answered. */
const FATAL_CHECK_IDS: ReadonlySet<string> = new Set([
  // The doctor call itself could not finish: orcad is unreachable.
  'environment.doctor',
  // The repository isn't where the workspace would open.
  'workspace.path',
  // Git can't read the checkout.
  'git.repo',
  'tool.git'
])

export type CloudSetupNoticeKind = 'push' | 'setup' | 'check'

/** One problem the opened workspace shows as a single dismissible line. */
export type CloudSetupNotice = {
  /** Stable per problem, so a dismissal or a re-check replaces the same line. */
  id: string
  kind: CloudSetupNoticeKind
  check: EnvironmentDoctorCheck
}

export type CloudEnvironmentCheckTriage = {
  /** Fatal failures: the create waits on the user (and the sandbox sleeps if they don't come back). */
  fatal: EnvironmentDoctorCheck[]
  /** Everything else worth one line in the opened workspace. */
  notices: CloudSetupNotice[]
}

export function isFatalEnvironmentCheck(check: EnvironmentDoctorCheck): boolean {
  return check.status === 'fail' && FATAL_CHECK_IDS.has(check.id)
}

/**
 * Splits an Orca Cloud doctor result. Agent sign-in is never a check here: the account's agent row
 * and the in-workspace sign-in strip own it. A setup script the create is about to run is not news.
 */
export function triageCloudEnvironmentChecks(
  checks: readonly EnvironmentDoctorCheck[],
  options: { setupRunsOnCreate: boolean }
): CloudEnvironmentCheckTriage {
  const fatal: EnvironmentDoctorCheck[] = []
  const notices: CloudSetupNotice[] = []
  for (const check of checks) {
    if (check.status === 'pass') {
      continue
    }
    if (isFatalEnvironmentCheck(check)) {
      fatal.push(check)
      continue
    }
    const kind = noticeKind(check, options)
    if (kind) {
      notices.push({ id: check.id, kind, check })
    }
  }
  return { fatal, notices }
}

function noticeKind(
  check: EnvironmentDoctorCheck,
  options: { setupRunsOnCreate: boolean }
): CloudSetupNoticeKind | null {
  if (check.category === 'agents') {
    return null
  }
  switch (check.id) {
    case 'git.push':
      // "No commits yet" is a warn with nothing to do; only a refused push needs access.
      return check.status === 'fail' ? 'push' : null
    case 'setup.run':
      return options.setupRunsOnCreate ? null : 'setup'
    // Advice for the repository, not a problem with this workspace.
    case 'setup.script':
    case 'git.remote':
      return null
    default:
      return 'check'
  }
}
