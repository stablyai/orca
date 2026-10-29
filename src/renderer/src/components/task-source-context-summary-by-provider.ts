import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { TaskProvider } from '../../../shared/task-providers'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  getAccountBackedTaskSourceSummary,
  getRepoBackedTaskSourceSummary,
  type HostLabelLookup,
  type TaskSourceContextSummary,
  type TaskSourceHostAvailability
} from './task-source-context-summary'

type TaskSourceContextSummaryArgs = {
  provider: TaskProvider
  providerLabel: string
  repoContexts?: readonly TaskSourceContext[]
  hostAvailability?: readonly TaskSourceHostAvailability[]
  hostLabelById?: HostLabelLookup
  accountHostId?: ExecutionHostScope | null
  selectedRepoCount?: number
  linearWorkspaceName?: string | null
  jiraSiteName?: string | null
  azureDevOpsProjectName?: string | null
}

function accountBackedSummary(
  args: TaskSourceContextSummaryArgs,
  accountLabel: string | null | undefined
): TaskSourceContextSummary {
  return getAccountBackedTaskSourceSummary(args.providerLabel, {
    accountLabel,
    accountHostId: args.accountHostId,
    hostLabelById: args.hostLabelById,
    hostAvailability: args.hostAvailability
  })
}

// Why: Record keyed by TaskProvider (not switch/if) so every provider needs a branch.
const TASK_SOURCE_CONTEXT_SUMMARY_BUILDERS: Record<
  TaskProvider,
  (args: TaskSourceContextSummaryArgs) => TaskSourceContextSummary
> = {
  github: getRepoBackedTaskSourceSummary,
  gitlab: getRepoBackedTaskSourceSummary,
  linear: (args) => accountBackedSummary(args, args.linearWorkspaceName),
  jira: (args) => accountBackedSummary(args, args.jiraSiteName),
  'azure-devops': (args) => accountBackedSummary(args, args.azureDevOpsProjectName)
}

export function getTaskSourceContextSummary(
  args: TaskSourceContextSummaryArgs
): TaskSourceContextSummary {
  return TASK_SOURCE_CONTEXT_SUMMARY_BUILDERS[args.provider](args)
}
