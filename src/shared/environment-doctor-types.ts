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
