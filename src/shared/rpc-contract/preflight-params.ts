import { z } from 'zod'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../constants'
import { parseRoutableExecutionHostId } from '../execution-host'
import { OptionalExecutionHostId } from './worktree-params'
import { RepoSelector } from './github-repo-target-params'
import type { TuiAgent } from '../tui-agent'
import type { WorkspaceLaunchKind } from '../workspace-launch-kind'
import type { ProjectExecutionRuntimeResolution } from '../project-execution-runtime'

export const PreflightCheck = z.object({
  force: z.boolean().optional()
})

export const PreflightDetectRemoteAgents = z.object({
  connectionId: z.string().min(1)
})

export const PreflightDetectRemoteWindowsTerminalCapabilities = z.object({
  connectionId: z.string().min(1)
})

/** Why optional: a client that predates it sends nothing and keeps the host-default probe. */
export const PreflightAgentDetection = z
  .object({
    worktreeId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    worktreeHostId: OptionalExecutionHostId
  })
  .superRefine((params, ctx) => {
    if (
      params.worktreeHostId !== undefined &&
      (!parseRoutableExecutionHostId(params.worktreeHostId) ||
        !params.worktreeId ||
        params.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
    ) {
      ctx.addIssue({ code: 'custom', message: 'A routable host requires an existing workspace.' })
    }
  })

export const PreflightProjectAgentDetection = PreflightAgentDetection.safeExtend({
  project: RepoSelector.extend({ repo: RepoSelector.shape.repo.pipe(z.string().max(4096)) })
    .strict()
    .optional()
}).refine(
  (value) => !value.project || (!value.worktreeId && !value.repoId && !value.worktreeHostId),
  'Choose project, repository or worktree'
)

/** Facts resolved by the same project owner that creates the workspace. */
export type ProjectLaunchContext = {
  agents: TuiAgent[]
  workspaceKind: WorkspaceLaunchKind
  executionContext:
    | { kind: 'host'; projectRuntime: ProjectExecutionRuntimeResolution }
    | { kind: 'ssh' }
}
