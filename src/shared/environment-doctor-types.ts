import type {
  EphemeralVmRecipeDoctorCheck,
  EphemeralVmRecipeDoctorCheckStatus
} from './ephemeral-vm-recipes'

export type EnvironmentDoctorCheckStatus = EphemeralVmRecipeDoctorCheckStatus

export type EnvironmentDoctorCategory = 'workspace' | 'tools' | 'agents' | 'git' | 'setup' | 'disk'

export type EnvironmentDoctorCheck = EphemeralVmRecipeDoctorCheck & {
  category: EnvironmentDoctorCategory
}

export type EnvironmentDoctorResult = {
  worktreePath: string
  /** False when any check failed; warnings keep it true, so read `checks` for a clean bill. */
  ok: boolean
  checks: EnvironmentDoctorCheck[]
}

/** One line per check plus indented remediation; shared by the CLI and the agent prompt. */
export function formatEnvironmentDoctorChecks(checks: readonly EnvironmentDoctorCheck[]): string[] {
  return checks.flatMap((check) => [
    `${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.message}`,
    ...(check.remediation ? check.remediation.split('\n').map((line) => `     ${line}`) : [])
  ])
}
