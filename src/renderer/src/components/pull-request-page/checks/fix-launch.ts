import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { startFixChecksAgent } from '@/lib/fix-checks-agent-launch'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { buildFixBrokenChecksPrompt } from '../../../../../shared/pr-checks-fix-prompt'
import type { SourceControlAiWriteTarget } from '../../../../../shared/source-control-ai-recipe-save'
import { saveSourceControlAiActionRecipeForTarget } from '../../right-sidebar/source-control/ai/recipe-persistence'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../../shared/source-control-ai-actions'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'

type StoreState = ReturnType<typeof useAppStore.getState>

export async function saveFixChecksActionDefault(
  target: SourceControlAiWriteTarget,
  actionId: SourceControlLaunchActionId,
  recipe: SourceControlActionRecipe,
  updateSettings: StoreState['updateSettingsOrThrow'],
  updateRepo: StoreState['updateRepo']
): Promise<void> {
  await saveSourceControlAiActionRecipeForTarget({
    getStoreState: useAppStore.getState,
    updateSettings,
    updateRepo,
    target,
    actionId,
    recipe
  })
}

export async function startFixChecksFromDialog(args: {
  targetRepoId: string | null
  item: GitHubWorkItem
  agent: Parameters<typeof launchWorkItemDirect>[0]['agentOverride']
  commandInput: string
  /** Omitted when CLI arguments do not apply, so the launch resolves the global Agents setting. */
  agentArgs?: string
  sessionOptions?: Readonly<Record<string, string>>
  launchChoice?: Parameters<typeof launchWorkItemDirect>[0]['launchChoice']
  agentLaunchPreferences?: Parameters<typeof launchWorkItemDirect>[0]['agentLaunchPreferences']
  sessionOptionsYieldToAgentArgs?: true
}): Promise<boolean> {
  if (!args.targetRepoId) {
    return false
  }
  return await launchWorkItemDirect({
    item: { ...args.item, repoId: args.targetRepoId, pasteContent: args.commandInput },
    repoId: args.targetRepoId,
    launchSource: 'task_page',
    telemetrySource: 'sidebar',
    promptDelivery: 'submit-after-ready',
    agentOverride: args.agent,
    agentLaunchPreferences: args.agentLaunchPreferences,
    agentArgs: args.agentArgs,
    ...(args.sessionOptions ? { sessionOptions: args.sessionOptions } : {}),
    ...(args.launchChoice ? { launchChoice: args.launchChoice } : {}),
    sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
    openModalFallback: () => {
      toast.error(
        translate(
          'auto.components.PullRequestPage.c4c02ea23e',
          'Unable to create a fix workspace automatically.'
        )
      )
    }
  })
}

export async function fixBrokenPullRequestChecks(args: {
  targetRepoId: string | null
  fixingChecks: boolean
  failedChecks: PRCheckDetail[]
  item: GitHubWorkItem
  list: PRCheckDetail[]
  setFixingChecks: (value: boolean) => void
  setFixChecksComposerPrompt: (value: string | null) => void
}): Promise<void> {
  if (!args.targetRepoId || args.fixingChecks) {
    return
  }
  if (args.failedChecks.length === 0) {
    toast.message(
      translate('auto.components.PullRequestPage.51c65c0265', 'No broken checks to fix.')
    )
    return
  }

  const basePrompt = buildFixBrokenChecksPrompt({
    reviewKind: 'PR',
    reviewNumber: args.item.number,
    reviewTitle: args.item.title,
    reviewUrl: args.item.url,
    checks: args.list
  })
  args.setFixingChecks(true)
  try {
    const started = await startFixChecksAgent({
      item: args.item,
      repoId: args.targetRepoId,
      basePrompt,
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: () => {
        args.setFixChecksComposerPrompt(basePrompt)
      }
    })
    if (started) {
      toast.success(
        translate(
          'auto.components.PullRequestPage.85e62c5266',
          'Started an AI agent for the broken checks.'
        )
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Failed to start fix checks agent', err)
    toast.error(
      translate(
        'auto.components.PullRequestPage.98583589c6',
        'Failed to start an AI agent for the broken checks: {{value0}}',
        { value0: message }
      )
    )
  } finally {
    args.setFixingChecks(false)
  }
}
