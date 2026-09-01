import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { startFixChecksAgent } from '@/lib/fix-checks-agent-launch'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { buildFixBrokenChecksPrompt } from '@/components/pr-checks-fix-prompt'
import {
  saveSourceControlActionRecipe,
  type SourceControlAiWriteTarget
} from '../../../../../shared/source-control-ai-recipe-save'
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
  updateSettings: StoreState['updateSettings'],
  updateRepo: StoreState['updateRepo']
): Promise<void> {
  const state = useAppStore.getState()
  const latestSettings = state.settings
  if (!latestSettings) {
    throw new Error('Settings are not loaded.')
  }
  const latestRepo =
    target.type === 'repo'
      ? (state.repos.find((candidate) => candidate.id === target.repoId) ?? null)
      : null
  const result = saveSourceControlActionRecipe({
    target,
    settings: latestSettings,
    repo: latestRepo,
    actionId,
    recipe
  })
  if ('sourceControlAi' in result) {
    await updateSettings({ sourceControlAi: result.sourceControlAi })
    return
  }
  await updateRepo(result.target.repoId, result.update)
}

export async function startFixChecksFromDialog(args: {
  targetRepoId: string | null
  item: GitHubWorkItem
  agent: Parameters<typeof launchWorkItemDirect>[0]['agentOverride']
  commandInput: string
  agentArgs: string
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
