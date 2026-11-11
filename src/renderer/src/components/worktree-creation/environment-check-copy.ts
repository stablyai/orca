import type { Translate } from '@/i18n/use-translate'
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'

/** A check's message and fix in the UI language; uncoded checks (older servers) keep the host's English. */
export function environmentCheckCopy(
  check: EnvironmentDoctorCheck,
  t: Translate,
  cloud = false
): { message: string; remediation: string | null } {
  const p = check.params ?? {}
  if (cloud) {
    const fatal = cloudFatalCheckMessage(check, t)
    if (fatal) {
      // The card's body carries the one way forward (Start again), so no per-row fix.
      return { message: fatal, remediation: null }
    }
  }
  switch (check.code) {
    case 'gitMissing':
      return {
        message: t(
          'auto.components.worktree.creation.environmentCheckCopy.gitMissing',
          'git isn’t installed.'
        ),
        remediation: t(
          'auto.components.worktree.creation.environmentCheckCopy.gitMissingFix',
          'Add git to the environment image.'
        )
      }
    case 'toolMissing':
      if (p.command && p.reason) {
        return {
          message: t(
            'auto.components.worktree.creation.environmentCheckCopy.toolMissing',
            '{{command}} isn’t installed, but {{reason}} needs it.',
            { command: p.command, reason: p.reason }
          ),
          remediation: cloud
            ? t(
                'auto.components.worktree.creation.environmentCheckCopy.toolMissingFixCloud',
                'Install {{command}} in the workspace, or add it to your project’s setup script.',
                { command: p.command }
              )
            : t(
                'auto.components.worktree.creation.environmentCheckCopy.toolMissingFix',
                'Add {{command}} to the environment image or setup script.',
                { command: p.command }
              )
        }
      }
      break
    case 'agentMissing':
      return {
        message: t(
          'auto.components.worktree.creation.environmentCheckCopy.agentMissing',
          'No coding agent is installed.'
        ),
        remediation: t(
          'auto.components.worktree.creation.environmentCheckCopy.agentMissingFix',
          'Install the agent you want to run here, such as Claude or Codex.'
        )
      }
    case 'agentSignedOut':
    case 'agentSignInTimedOut':
      if (p.agent) {
        return {
          message:
            check.code === 'agentSignedOut'
              ? t(
                  'auto.components.worktree.creation.environmentCheckCopy.agentSignedOut',
                  '{{agent}} is installed but not signed in.',
                  { agent: p.agent }
                )
              : t(
                  'auto.components.worktree.creation.environmentCheckCopy.agentSignInTimedOut',
                  'Couldn’t confirm that {{agent}} is signed in.',
                  { agent: p.agent }
                ),
          // The agent pane asks for sign-in the first time the agent starts on this host.
          remediation: t(
            'auto.components.worktree.creation.environmentCheckCopy.agentSignInFix',
            'Orca asks you to sign in to {{agent}} the first time it starts in this workspace.',
            { agent: p.agent }
          )
        }
      }
      break
    case 'setupNotRun':
      return {
        message: t(
          'auto.components.worktree.creation.environmentCheckCopy.setupNotRun',
          'Setup script hasn’t run yet.'
        ),
        remediation: null
      }
    case 'diskVeryLow':
    case 'diskLow':
      if (p.free) {
        return {
          message: t(
            'auto.components.worktree.creation.environmentCheckCopy.diskLow',
            'Only {{free}} GB of disk space is free.',
            { free: p.free }
          ),
          remediation:
            check.code === 'diskVeryLow'
              ? t(
                  'auto.components.worktree.creation.environmentCheckCopy.diskVeryLowFix',
                  'Installs and builds will fail. Use a larger disk or clear caches.'
                )
              : t(
                  'auto.components.worktree.creation.environmentCheckCopy.diskLowFix',
                  'Dependency installs can need several GB. Consider a larger disk.'
                )
        }
      }
      break
    case undefined:
    default:
      break
  }
  return { message: check.message, remediation: check.remediation ?? null }
}

/** Orca Cloud's create-stopping checks in plain words; null for every other check. */
function cloudFatalCheckMessage(check: EnvironmentDoctorCheck, t: Translate): string | null {
  if (check.status !== 'fail') {
    return null
  }
  switch (check.id) {
    case 'environment.doctor':
      return t(
        'auto.components.worktree.creation.environmentCheckCopy.cloudUnreachable',
        'Orca couldn’t reach the sandbox.'
      )
    case 'workspace.path':
      return t(
        'auto.components.worktree.creation.environmentCheckCopy.cloudRepoMissing',
        'The repository isn’t in the sandbox.'
      )
    case 'git.repo':
      return t(
        'auto.components.worktree.creation.environmentCheckCopy.cloudRepoUnreadable',
        'Git can’t read the repository in the sandbox.'
      )
    case 'tool.git':
      return t(
        'auto.components.worktree.creation.environmentCheckCopy.cloudGitMissing',
        'git isn’t installed in the sandbox.'
      )
    default:
      return null
  }
}

export function environmentCheckBadge(
  status: EnvironmentDoctorCheck['status'],
  t: Translate
): string {
  return status === 'fail'
    ? t('auto.components.worktree.creation.environmentCheckCopy.failed', 'Failed')
    : status === 'warn'
      ? t('auto.components.worktree.creation.environmentCheckCopy.warning', 'Warning')
      : t('auto.components.worktree.creation.environmentCheckCopy.passed', 'Passed')
}
