import type { ExecutionHostScope } from '../../../../../shared/execution-host/execution-host'
import type { Translate } from '@/i18n/use-translate'
import type { TaskProvider } from '../../../../../shared/work-items/task-providers'
import type { TaskProviderIdentity } from '../../../../../shared/work-items/task-provider-identity'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
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
  repoIdentities?: readonly (TaskProviderIdentity | null)[]
  hostAvailability?: readonly TaskSourceHostAvailability[]
  hostLabelById?: HostLabelLookup
  accountHostId?: ExecutionHostScope | null
  selectedRepoCount?: number
  linearWorkspaceName?: string | null
  jiraSiteName?: string | null
  azureDevOpsProjectName?: string | null
}

/** The repo-backed summary needs both lists; account-backed providers supply neither. */
function repoBackedSummary(
  args: TaskSourceContextSummaryArgs,
  t?: Translate
): TaskSourceContextSummary {
  return getRepoBackedTaskSourceSummary(
    {
      ...args,
      repoContexts: args.repoContexts ?? [],
      repoIdentities: args.repoIdentities ?? []
    },
    t
  )
}

function accountBackedSummary(
  args: TaskSourceContextSummaryArgs,
  accountLabel: string | null | undefined,
  t?: Translate
): TaskSourceContextSummary {
  return getAccountBackedTaskSourceSummary(
    args.providerLabel,
    {
      accountLabel,
      accountHostId: args.accountHostId,
      hostLabelById: args.hostLabelById,
      hostAvailability: args.hostAvailability
    },
    t
  )
}

// Why: Record keyed by TaskProvider (not switch/if) so every provider needs a branch.
const TASK_SOURCE_CONTEXT_SUMMARY_BUILDERS: Record<
  TaskProvider,
  (args: TaskSourceContextSummaryArgs, t?: Translate) => TaskSourceContextSummary
> = {
  github: repoBackedSummary,
  gitlab: repoBackedSummary,
  linear: (args, t) => accountBackedSummary(args, args.linearWorkspaceName, t),
  jira: (args, t) => accountBackedSummary(args, args.jiraSiteName, t),
  'azure-devops': (args, t) => accountBackedSummary(args, args.azureDevOpsProjectName, t)
}

export function getTaskSourceContextSummary(
  args: TaskSourceContextSummaryArgs,
  t?: Translate
): TaskSourceContextSummary {
  return TASK_SOURCE_CONTEXT_SUMMARY_BUILDERS[args.provider](args, t)
}
