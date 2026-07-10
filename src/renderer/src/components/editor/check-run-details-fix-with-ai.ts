import { toast } from 'sonner'
import { useCallback, useMemo, useState } from 'react'
import {
  buildCheckRunDetailsFixBasePrompt,
  getCheckRunDetailsFixDisabledReason,
  isCheckRunDetailsFixCandidate,
  resolveCheckRunDetailsFixCheck,
  resolveHostedReviewForCheckRunDetailsFix,
  resolveCheckRunDetailsFixRepo
} from './check-run-details-fix-context'
import { openSourceControlAiSettingsTarget } from '@/components/right-sidebar/source-control-ai-settings-navigation'
import { getConnectionId } from '@/lib/connection-context'
import { startFixChecksAgent } from '@/lib/fix-checks-agent-launch'
import { readSourceControlLaunchRecipeAgentId } from '@/lib/source-control-launch-agent-selection'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai'
import {
  saveSourceControlActionRecipe,
  type SourceControlAiWriteTarget
} from '../../../../shared/source-control-ai-recipe-save'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export {
  buildCheckRunDetailsFixBasePrompt,
  getCheckRunDetailsFixDisabledReason,
  isCheckRunDetailsFixCandidate,
  resolveCheckRunDetailsFixCheck,
  resolveHostedReviewForCheckRunDetailsFix
} from './check-run-details-fix-context'

export async function startCheckRunDetailsFixWithAI(args: {
  worktreeId: string
  check: PRCheckDetail
  details: PRCheckRunDetails | null
}): Promise<boolean> {
  const disabledReason = getCheckRunDetailsFixDisabledReason(args.worktreeId)
  if (disabledReason) {
    toast.message(disabledReason)
    return false
  }
  const resolvedCheck = resolveCheckRunDetailsFixCheck(args.check, args.details)
  if (!isCheckRunDetailsFixCandidate(resolvedCheck)) {
    toast.message(
      translate(
        'auto.components.editor.check.run.details.fix.with.ai.9b2f6d4a81',
        'This check is not failing.'
      )
    )
    return false
  }
  const review = resolveHostedReviewForCheckRunDetailsFix(args.worktreeId)
  if (!review) {
    toast.message(
      translate(
        'auto.components.editor.check.run.details.fix.with.ai.7c3e1b5d42',
        'Open a PR or MR before launching an AI fix.'
      )
    )
    return false
  }
  const repoId = resolveCheckRunDetailsFixRepo(args.worktreeId)?.id
  if (!repoId) {
    return false
  }
  const basePrompt =
    buildCheckRunDetailsFixBasePrompt({
      worktreeId: args.worktreeId,
      check: args.check,
      details: args.details
    }) ?? ''
  if (!basePrompt) {
    return false
  }
  const started = await startFixChecksAgent({
    repoId,
    basePrompt,
    worktreeId: args.worktreeId,
    groupId: args.worktreeId,
    launchSource: 'task_page'
  })
  if (started) {
    toast.success(
      translate(
        'auto.components.editor.check.run.details.fix.with.ai.2ef90c9819',
        'Started an AI agent for this check.'
      )
    )
  }
  return started
}

export function useCheckRunDetailsFixWithAI(args: {
  worktreeId: string | null
  check: PRCheckDetail
  details: PRCheckRunDetails | null
}): {
  canFixWithAI: boolean
  disabledReason: string | undefined
  isFixing: boolean
  fixPrompt: string | null
  repoId: string | null
  connectionId: string | null | undefined
  launchPlatform: NodeJS.Platform | undefined
  savedAgentId: ReturnType<typeof readSourceControlLaunchRecipeAgentId>
  savedCommandInputTemplate: string | null
  savedAgentArgs: string | null
  saveLaunchActionDefault: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => Promise<void>
  openSourceControlAiSettings: () => void
  fixWithAI: () => Promise<boolean>
} {
  const [isFixing, setIsFixing] = useState(false)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const updateRepo = useAppStore((state) => state.updateRepo)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const repo = useMemo(() => resolveCheckRunDetailsFixRepo(args.worktreeId), [args.worktreeId])
  const worktree = useMemo(() => {
    if (!args.worktreeId) {
      return null
    }
    return findWorktreeById(useAppStore.getState().worktreesByRepo, args.worktreeId)
  }, [args.worktreeId])
  const canFixWithAI = isCheckRunDetailsFixCandidate(args.check, args.details)
  const disabledReason = getCheckRunDetailsFixDisabledReason(args.worktreeId)
  const fixPrompt = useMemo(() => {
    if (!args.worktreeId || !canFixWithAI) {
      return null
    }
    return buildCheckRunDetailsFixBasePrompt({
      worktreeId: args.worktreeId,
      check: args.check,
      details: args.details
    })
  }, [args.check, args.details, args.worktreeId, canFixWithAI])
  const connectionId = args.worktreeId
    ? (getConnectionId(args.worktreeId) ?? repo?.connectionId ?? null)
    : null
  const launchPlatform = resolveSourceControlLaunchPlatform({
    connectionId,
    worktreePath: worktree?.path ?? null
  })
  const fixChecksRecipe = useMemo(
    () =>
      resolveSourceControlActionRecipe({
        settings,
        repo,
        actionId: 'fixChecks'
      }),
    [repo, settings]
  )
  const saveLaunchActionDefault = useCallback(
    async (
      target: SourceControlAiWriteTarget,
      actionId: SourceControlLaunchActionId,
      recipe: SourceControlActionRecipe
    ): Promise<void> => {
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
    },
    [updateRepo, updateSettings]
  )
  const openSourceControlAiSettings = useCallback((): void => {
    openSourceControlAiSettingsTarget({
      activeRepo: repo,
      openSettingsTarget,
      openSettingsPage
    })
  }, [openSettingsPage, openSettingsTarget, repo])

  const fixWithAI = useCallback(async (): Promise<boolean> => {
    if (!args.worktreeId || isFixing || disabledReason) {
      return false
    }
    setIsFixing(true)
    try {
      return await startCheckRunDetailsFixWithAI({
        worktreeId: args.worktreeId,
        check: args.check,
        details: args.details
      })
    } finally {
      setIsFixing(false)
    }
  }, [args.check, args.details, args.worktreeId, disabledReason, isFixing])

  return {
    canFixWithAI,
    disabledReason,
    isFixing,
    fixPrompt,
    repoId: repo?.id ?? null,
    connectionId,
    launchPlatform,
    savedAgentId: readSourceControlLaunchRecipeAgentId(fixChecksRecipe),
    savedCommandInputTemplate: fixChecksRecipe.commandInputTemplate ?? null,
    savedAgentArgs: fixChecksRecipe.agentArgs ?? null,
    saveLaunchActionDefault,
    openSourceControlAiSettings,
    fixWithAI
  }
}
