import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isSourceControlAgentDetectedAndEnabled } from './source-control-agent-action-dialog-support'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai'
import { sourceControlActionRecipeMatchesTarget } from './source-control-action-recipe-match'

type SavedSourceControlAgentActionTargetValue = 'repo' | 'global'

const NO_SAVED_RECEIPT_KEY = '__no_saved_receipt__'

type UseSavedSourceControlAgentActionAutoStartArgs = {
  open: boolean
  openCycle: number
  detectionReady: boolean
  /** This cycle's discovery was cancelled or failed: it verified nothing to start on. */
  detectionFailed: boolean
  actionId: SourceControlLaunchActionId
  baseCommandInput: string
  savedAgentId?: TuiAgent | null
  savedCommandInputTemplate?: string | null
  savedAgentArgs?: string | null
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo: Pick<Repo, 'sourceControlAi'> | null
  repoId?: string | null
  worktreeId?: string | null
  connectionId?: string | null
  selectedAgent: TuiAgent | null
  trimmedCommandInput: string
  connectionUnavailable: boolean
  detecting: boolean
  isStarting: boolean
  detectedAgents: TuiAgent[]
  disabledAgents: TuiAgent[] | undefined
  onAutoStart: (args: { detectedAgents: TuiAgent[] }) => Promise<boolean>
}

type SavedSourceControlAgentActionAutoStartResult = {
  autoLaunchPending: boolean
  matchedSavedReceiptTargetValue: SavedSourceControlAgentActionTargetValue | null
}

type AutoLaunchReceiptState = {
  openCycle: number
  receiptKey: string
  revealed: boolean
}

function buildSavedLaunchRecipe(input: {
  savedAgentId?: TuiAgent | null
  savedCommandInputTemplate?: string | null
  savedAgentArgs?: string | null
  savedLaunchPreferences?: SourceControlActionRecipe['launchPreferences']
}): SourceControlActionRecipe | null {
  if (!input.savedAgentId) {
    return null
  }
  return {
    agentId: input.savedAgentId,
    commandInputTemplate: input.savedCommandInputTemplate ?? '{basePrompt}',
    agentArgs: input.savedAgentArgs ?? '',
    ...(input.savedLaunchPreferences ? { launchPreferences: input.savedLaunchPreferences } : {})
  }
}

function getMatchedSavedReceiptTargetValue(input: {
  actionId: SourceControlLaunchActionId
  recipe: SourceControlActionRecipe | null
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo: Pick<Repo, 'sourceControlAi'> | null
  repoId?: string | null
}): SavedSourceControlAgentActionTargetValue | null {
  if (!input.recipe) {
    return null
  }
  if (
    input.repoId &&
    input.repo &&
    sourceControlActionRecipeMatchesTarget({
      actionId: input.actionId,
      target: { type: 'repo', repoId: input.repoId },
      recipe: input.recipe,
      settings: input.settings,
      repo: input.repo
    })
  ) {
    return 'repo'
  }
  if (
    sourceControlActionRecipeMatchesTarget({
      actionId: input.actionId,
      target: { type: 'global' },
      recipe: input.recipe,
      settings: input.settings,
      repo: input.repo
    })
  ) {
    return 'global'
  }
  return null
}

function buildReceiptKey(input: {
  actionId: SourceControlLaunchActionId
  targetValue: SavedSourceControlAgentActionTargetValue
  savedAgentId: TuiAgent
  savedCommandInputTemplate?: string | null
  savedAgentArgs?: string | null
  savedLaunchPreferences?: SourceControlActionRecipe['launchPreferences']
  repoId?: string | null
  connectionId?: string | null
  worktreeId?: string | null
  baseCommandInput: string
}): string {
  return JSON.stringify([
    input.actionId,
    input.targetValue,
    input.savedAgentId,
    input.savedCommandInputTemplate ?? '{basePrompt}',
    input.savedAgentArgs ?? '',
    input.savedLaunchPreferences ?? null,
    input.repoId ?? null,
    input.connectionId ?? null,
    input.worktreeId ?? null,
    input.baseCommandInput
  ])
}

export function useSavedSourceControlAgentActionAutoStart({
  open,
  openCycle,
  detectionReady,
  detectionFailed,
  actionId,
  baseCommandInput,
  savedAgentId,
  savedCommandInputTemplate,
  savedAgentArgs,
  settings,
  repo,
  repoId,
  worktreeId,
  connectionId,
  selectedAgent,
  trimmedCommandInput,
  connectionUnavailable,
  detecting,
  isStarting,
  detectedAgents,
  disabledAgents,
  onAutoStart
}: UseSavedSourceControlAgentActionAutoStartArgs): SavedSourceControlAgentActionAutoStartResult {
  const autoStartedOpenCycleRef = useRef(0)
  const [receiptState, setReceiptState] = useState<AutoLaunchReceiptState | null>(null)

  const savedLaunchPreferences = useMemo(() => {
    const effective = resolveSourceControlActionRecipe({ settings, repo, actionId })
    return effective.agentId === savedAgentId ? effective.launchPreferences : undefined
  }, [actionId, repo, savedAgentId, settings])
  const savedLaunchRecipe = useMemo(
    () =>
      buildSavedLaunchRecipe({
        savedAgentId,
        savedCommandInputTemplate,
        savedAgentArgs,
        savedLaunchPreferences
      }),
    [savedAgentArgs, savedAgentId, savedCommandInputTemplate, savedLaunchPreferences]
  )
  const matchedSavedReceiptTargetValue = useMemo(
    () =>
      getMatchedSavedReceiptTargetValue({
        actionId,
        recipe: savedLaunchRecipe,
        settings,
        repo,
        repoId
      }),
    [actionId, repo, repoId, savedLaunchRecipe, settings]
  )
  const receiptKey = useMemo(() => {
    if (!savedAgentId || !matchedSavedReceiptTargetValue) {
      return null
    }
    return buildReceiptKey({
      actionId,
      targetValue: matchedSavedReceiptTargetValue,
      savedAgentId,
      savedCommandInputTemplate,
      savedAgentArgs,
      savedLaunchPreferences,
      repoId,
      connectionId,
      worktreeId,
      baseCommandInput
    })
  }, [
    actionId,
    baseCommandInput,
    connectionId,
    matchedSavedReceiptTargetValue,
    repoId,
    savedAgentArgs,
    savedAgentId,
    savedCommandInputTemplate,
    savedLaunchPreferences,
    worktreeId
  ])

  const currentReceiptState = receiptState?.openCycle === openCycle ? receiptState : null
  const consideredDifferentReceipt = Boolean(
    currentReceiptState && receiptKey && currentReceiptState.receiptKey !== receiptKey
  )
  const autoLaunchPending = Boolean(
    open &&
    matchedSavedReceiptTargetValue &&
    receiptKey &&
    !consideredDifferentReceipt &&
    !currentReceiptState?.revealed &&
    !detectionFailed
  )

  useEffect(() => {
    if (!open) {
      autoStartedOpenCycleRef.current = 0
      setReceiptState(null)
      return
    }
    if (receiptState?.openCycle !== openCycle) {
      setReceiptState({
        openCycle,
        receiptKey: receiptKey ?? NO_SAVED_RECEIPT_KEY,
        revealed: !receiptKey
      })
    }
    if (!matchedSavedReceiptTargetValue || !receiptKey || !savedAgentId) {
      return
    }
    if (receiptState?.openCycle === openCycle && receiptState.receiptKey !== receiptKey) {
      return
    }
    if (receiptState?.openCycle === openCycle && receiptState.revealed) {
      return
    }
    const revealDialog = (): void => {
      setReceiptState({ openCycle, receiptKey, revealed: true })
    }
    // Recorded as revealed, so later healthy facts in this cycle never auto-start on another owner.
    if (detectionFailed) {
      revealDialog()
      return
    }
    if (!detectionReady || detecting || isStarting) {
      return
    }
    if (
      selectedAgent !== savedAgentId ||
      !trimmedCommandInput ||
      connectionUnavailable ||
      !isSourceControlAgentDetectedAndEnabled(savedAgentId, detectedAgents, disabledAgents)
    ) {
      revealDialog()
      return
    }
    if (autoStartedOpenCycleRef.current === openCycle) {
      return
    }
    autoStartedOpenCycleRef.current = openCycle
    void onAutoStart({ detectedAgents })
      .then((launched) => {
        if (!launched) {
          revealDialog()
        }
      })
      .catch(() => {
        revealDialog()
      })
  }, [
    connectionUnavailable,
    detectedAgents,
    detectionFailed,
    detectionReady,
    detecting,
    disabledAgents,
    isStarting,
    matchedSavedReceiptTargetValue,
    onAutoStart,
    open,
    openCycle,
    receiptKey,
    receiptState,
    savedAgentId,
    selectedAgent,
    trimmedCommandInput
  ])

  return { autoLaunchPending, matchedSavedReceiptTargetValue }
}
