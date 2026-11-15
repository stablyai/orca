import {
  agentLaunchRecoveryMessage,
  notifyAgentLaunchFailure
} from '@/lib/agent-session/launch/failure/agent-launch-failure'
import type { DirectWorkItemLaunchResult } from '@/lib/workspace/creation/work-item/direct-work-item-setup'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { startFixChecksAgent } from '@/lib/source-control/checks/fix-checks-agent-launch'
import { launchWorkItemDirect } from '@/lib/workspace/creation/work-item/launch-work-item-direct'
import { buildFixBrokenChecksPrompt } from '../../../../../shared/source-control/checks/pr-checks-fix-prompt'
import type { SourceControlAiWriteTarget } from '../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'
import { saveSourceControlAiActionRecipeForTarget } from '../../right-sidebar/source-control/ai/recipe-persistence'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/checks/check-types'

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
  signal?: AbortSignal
  onCreateAccepted?: () => void
  onFailureNotified?: () => void
  targetRepoId: string | null
  item: GitHubWorkItem
  agent: Parameters<typeof launchWorkItemDirect>[0]['agentOverride']
  commandInput: string
  /** Omitted when CLI arguments do not apply, so the launch resolves the global Agents setting. */
  agentArgs?: string
  actionAgentArgs?: string
  sessionOptions?: Readonly<Record<string, string>>
  chatSessionOptions?: Readonly<Record<string, string>>
  preferredSurface?: 'chat'
  launchChoice?: Parameters<typeof launchWorkItemDirect>[0]['launchChoice']
  agentLaunchPreferences?: Parameters<typeof launchWorkItemDirect>[0]['agentLaunchPreferences']
  sessionOptionsYieldToAgentArgs?: true
}): Promise<DirectWorkItemLaunchResult> {
  if (!args.targetRepoId) {
    return false
  }
  let failureNotified = false
  const onFailureNotified = () => {
    failureNotified = true
    args.onFailureNotified?.()
  }
  return await launchWorkItemDirect({
    signal: args.signal,
    onCreateAccepted: args.onCreateAccepted,
    onFailureNotified,
    item: { ...args.item, repoId: args.targetRepoId, pasteContent: args.commandInput },
    repoId: args.targetRepoId,
    launchSource: 'task_page',
    telemetrySource: 'sidebar',
    promptDelivery: 'submit-after-ready',
    agentOverride: args.agent,
    agentLaunchPreferences: args.agentLaunchPreferences,
    agentArgs: args.agentArgs,
    actionAgentArgs: args.actionAgentArgs,
    ...(args.sessionOptions ? { sessionOptions: args.sessionOptions } : {}),
    ...(args.chatSessionOptions !== undefined
      ? { chatSessionOptions: args.chatSessionOptions }
      : {}),
    ...(args.launchChoice || args.preferredSurface
      ? {
          launchChoice: {
            ...args.launchChoice,
            ...(args.preferredSurface ? { preferredSurface: args.preferredSurface } : {})
          }
        }
      : {}),
    sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
    openModalFallback: () => {
      if (failureNotified) {
        return
      }
      if (args.agent) {
        notifyAgentLaunchFailure(args.agent, agentLaunchRecoveryMessage('refreshProjects'))
      } else {
        toast.error(
          translate(
            'auto.components.PullRequestPage.c4c02ea23e',
            'Unable to create a fix workspace automatically.'
          )
        )
      }
      onFailureNotified()
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
      onSetupRequired: () => args.setFixChecksComposerPrompt(basePrompt),
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
