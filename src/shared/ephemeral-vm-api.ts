import type { AdoptProvisionedRootArgs, CreateWorktreeResult } from './worktree/create-types'
import type { OrcaHooks } from './orca-yaml-hook-types'
import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { EphemeralVmRecipeDoctorResult } from './ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from './ephemeral-vm-recipe-diagnostics'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

export type EphemeralVmOwner = { ownerEnvironmentId?: string }

export type EphemeralVmApi = {
  listRecipes: (args: { repoId: string } & EphemeralVmOwner) => Promise<{
    status: 'ok' | 'error'
    repoPath: string | null
    recipes: OrcaHooks['environmentRecipes']
    diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
    message?: string
  }>
  listRecipeCatalog: (args?: EphemeralVmOwner) => Promise<
    {
      ownerEnvironmentId?: string
      repoId: string
      repoName: string
      repoPath: string
      recipes: NonNullable<OrcaHooks['environmentRecipes']>
      diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
    }[]
  >
  doctor: (
    args: { repoId: string; recipeId: string } & EphemeralVmOwner
  ) => Promise<EphemeralVmRecipeDoctorResult>
  provision: (args: {
    ownerEnvironmentId?: string
    repoId: string
    recipeId: string
    workspaceRequest?: Record<string, unknown>
    workspaceName?: string
    projectId?: string
    workspaceId?: string
    branch?: string
    ref?: string
    provisionId?: string
  }) => Promise<
    | {
        ok: true
        connectionType: 'orca-server'
        runtime: EphemeralVmRuntimeRecord
        environment: PublicKnownRuntimeEnvironment
        stderr: string
        warnings: EphemeralVmRecipeResultWarning[]
      }
    | {
        ok: true
        connectionType: 'ssh'
        runtime: EphemeralVmRuntimeRecord
        sshTargetId: string
        /** The managed Orca server the host runs; its workspace lives there. */
        environmentId?: string
        expectedRefHead?: string
        stderr: string
        warnings: EphemeralVmRecipeResultWarning[]
      }
    | { ok: false; error: string; stderr: string; stdout: string }
  >
  adoptProvisionedRoot: (
    args: AdoptProvisionedRootArgs & EphemeralVmOwner
  ) => Promise<CreateWorktreeResult>
  cancelProvision: (
    args: { provisionId: string } & EphemeralVmOwner
  ) => Promise<{ cancelled: boolean }>
  onProvisionEvent: (
    callback: (event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void
  ) => () => void
  listRuntimes: (args?: EphemeralVmOwner) => Promise<EphemeralVmRuntimeRecord[]>
  attachWorkspace: (args: {
    ownerEnvironmentId?: string
    runtimeId: string
    workspaceId: string
  }) => Promise<EphemeralVmRuntimeRecord>
  suspendWorkspace: (
    args: { workspaceId: string } & EphemeralVmOwner
  ) => Promise<EphemeralVmRuntimeRecord | null>
  resumeWorkspace: (
    args: { workspaceId: string } & EphemeralVmOwner
  ) => Promise<EphemeralVmRuntimeRecord | null>
  cleanup: (args: { runtimeId: string } & EphemeralVmOwner) => Promise<EphemeralVmRuntimeRecord>
  stopCleanup: (args: { runtimeId: string } & EphemeralVmOwner) => Promise<EphemeralVmRuntimeRecord>
  getCleanupCommand: (args: { runtimeId: string } & EphemeralVmOwner) => Promise<{
    ownerEnvironmentId?: string
    runtimeId: string
    command: string | null
    payloadJson: string
    cleanupDisabled: boolean
    message?: string
  }>
}
