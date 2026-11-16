import type { PublicKnownRuntimeEnvironment } from '../host-catalog/runtime-environments'
import type { EphemeralVmProvisionedRuntimeRecord } from '../ephemeral-vm-store/ephemeral-vm-runtimes'
import type { EphemeralVmRecipeResultWarning } from './ephemeral-vm-recipe-diagnostics'
import type { EphemeralVmFailure } from './ephemeral-vm-failure-copy'

/** What provisioning a recipe environment answers, to the new-workspace dialog and to the CLI. */
export type RecipeEnvironmentProvisionResult =
  | {
      ok: true
      connectionType: 'orca-server'
      runtime: EphemeralVmProvisionedRuntimeRecord
      environment: PublicKnownRuntimeEnvironment
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: true
      connectionType: 'ssh'
      runtime: EphemeralVmProvisionedRuntimeRecord
      sshTargetId: string
      /** The managed Orca server the host runs; its workspace lives there. */
      environmentId?: string
      expectedRefHead?: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | ({
      ok: false
      stderr: string
      stdout: string
      /** Set when the create step had already started a VM that this failure then destroyed. */
      runtimeId?: string
      environmentCleanup?: 'destroyed' | 'failed' | 'disabled'
    } & EphemeralVmFailure)

/** Named steps of provisioning, for callers that show progress. */
export type RecipeEnvironmentProvisionPhase =
  | 'resolving-start-ref'
  | 'running-create'
  | 'connecting'
