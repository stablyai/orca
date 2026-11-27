import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../workspace/identity/floating-workspace-id'
import { parseRoutableExecutionHostId } from '../../execution-host/execution-host'
import { OptionalExecutionHostId } from '../workspaces/worktree-params'
import { RepoSelector } from '../github/github-repo-target-params'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import type { WorkspaceLaunchKind } from '../../agent-launch/contracts/workspace-launch-kind'
import type { ProjectExecutionRuntimeResolution } from '../../execution-host/project-execution-runtime'
import { TERMINAL_INPUT_MAX_BYTES } from '../../terminal/input/terminal-input'
import { OptionalNativeChatSignIn } from '../terminal/native-chat-sign-in-params'

export const PreflightQueuedAgentLaunch = lazyZodSchema(() =>
  z.object({
    terminal: z.string().min(1).max(4096),
    command: z.string().min(1).max(TERMINAL_INPUT_MAX_BYTES),
    shell: z.enum(['posix', 'powershell', 'cmd']),
    shellOverride: z.string().max(4096).optional(),
    cwd: z.string().max(4096).optional(),
    launchConfig: z
      .object({
        agentCommand: z.string().optional(),
        agentArgs: z.string(),
        agentEnv: z.record(z.string(), z.string()),
        commandProvenance: z.enum(['authored', 'generated']).optional(),
        authoredCommand: z.string().optional(),
        selectedExecutable: z.string().optional(),
        ompResumeFilePath: z.string().optional()
      })
      .optional(),
    launchAgent: z.custom<TuiAgent>(isTuiAgent).optional(),
    restoring: z.boolean().optional(),
    nativeChatSignIn: OptionalNativeChatSignIn,
    images: z.boolean().optional()
  })
)

export const PreflightCheck = lazyZodSchema(() =>
  z.object({
    force: z.boolean().optional()
  })
)

export const PreflightDetectRemoteAgents = lazyZodSchema(() =>
  z.object({
    connectionId: z.string().min(1)
  })
)

export const PreflightDetectRemoteWindowsTerminalCapabilities = lazyZodSchema(() =>
  z.object({
    connectionId: z.string().min(1)
  })
)

/** Why optional: a client that predates it sends nothing and keeps the host-default probe. */
export const PreflightAgentDetection = lazyZodSchema(() =>
  z
    .object({
      worktreeId: z.string().min(1).optional(),
      repoId: z.string().min(1).optional(),
      worktreeHostId: OptionalExecutionHostId,
      // Host-scoped lists (MCP agents) probe the configured Windows Agent runtime, as desktop
      // does with nothing focused; without it, no identity keeps meaning the native host.
      configuredWindowsRuntime: z.literal(true).optional()
    })
    .superRefine((params, ctx) => {
      if (params.configuredWindowsRuntime && (params.worktreeId || params.repoId)) {
        ctx.addIssue({ code: 'custom', message: 'A workspace already names its runtime.' })
      }
      if (
        params.worktreeHostId !== undefined &&
        (!parseRoutableExecutionHostId(params.worktreeHostId) ||
          !params.worktreeId ||
          params.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
      ) {
        ctx.addIssue({ code: 'custom', message: 'A routable host requires an existing workspace.' })
      }
    })
)

export const PreflightAgentRefresh = lazyZodSchema(() =>
  PreflightAgentDetection.safeExtend({
    userInitiated: z.boolean().optional(),
    withManagedAgentCommands: z.boolean().optional()
  })
)

export const PreflightProjectAgentDetection = lazyZodSchema(() =>
  PreflightAgentDetection.safeExtend({
    /** Answer `{ agents, managedAgentCommands }`; older hosts drop it and answer the list alone. */
    withManagedAgentCommands: z.boolean().optional(),
    afterPublication: z.number().int().nonnegative().optional(),
    launch: PreflightQueuedAgentLaunch.optional(),
    nativeChatSignIn: OptionalNativeChatSignIn,
    project: RepoSelector.extend({ repo: RepoSelector.shape.repo.pipe(z.string().max(4096)) })
      .strict()
      .optional()
  }).refine(
    (value) =>
      !value.project ||
      (!value.worktreeId &&
        !value.repoId &&
        !value.worktreeHostId &&
        !value.configuredWindowsRuntime &&
        !value.launch &&
        !value.nativeChatSignIn),
    'Choose project, repository or worktree'
  )
)

/** Facts resolved by the same project owner that creates the workspace. */
export type ProjectLaunchContext = {
  agents: TuiAgent[]
  incomplete?: boolean
  workspaceKind: WorkspaceLaunchKind
  executionContext:
    | { kind: 'host'; projectRuntime: ProjectExecutionRuntimeResolution }
    | { kind: 'ssh' }
}
