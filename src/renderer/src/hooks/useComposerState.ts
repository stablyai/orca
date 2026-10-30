import type { RefObject } from 'react'
import { useCallback, useState } from 'react'
import '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { pickQuickWorkspaceAgent } from '@/lib/quick-workspace-agent-selection'
import { MAX_COMPOSER_AGENT_ROWS } from '@/components/new-workspace/new-workspace-composer-card-props'
import {
  createComposerAgentEntry,
  type ComposerAgentEntry
} from './composer-state/composer-agent-entries'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { QuickSubmitOptions } from './composer-state/quick-creation-request'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { WorkspaceStatus } from '../../../shared/worktree/types'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import { buildComposerCardProps } from './composer-state/composer-card-props'
import {
  canResolveFolderSmartGitHubSubmit,
  getInitialAutoManagedWorkspaceName,
  getInitialGitHubPrStartPointSelection,
  getMatchingLinkedTaskSourceContext,
  isExplicitWorkspaceNameInput,
  resolveInitialWorkspaceRunSeed,
  resolveSmartGitHubCreateNames,
  retargetGitHubPrStartPointSelection,
  type ComposerDecisions
} from './composer-state/composer-decisions'
import { useComposerTargetState } from './composer-state/composer-target-state'
import { useComposerExternalSync } from './composer-state/composer-external-sync'
import { useComposerSourceState } from './composer-state/composer-source-state'
import { useComposerSubmitOrchestration } from './composer-state/composer-submit-orchestration'
import { assembleComposerModel } from './composer-state/assemble-composer-model'
import type {
  ComposerCardActionProps,
  ComposerCardSourceProps
} from './composer-state/composer-card-contract'

export {
  canResolveFolderSmartGitHubSubmit,
  getInitialAutoManagedWorkspaceName,
  getInitialGitHubPrStartPointSelection,
  getMatchingLinkedTaskSourceContext,
  isExplicitWorkspaceNameInput,
  resolveInitialWorkspaceRunSeed,
  resolveSmartGitHubCreateNames,
  retargetGitHubPrStartPointSelection
} from './composer-state/composer-decisions'
export type { InitialWorkspaceRunSeedInput } from './composer-state/composer-decisions'

export type UseComposerStateOptions = {
  initialRepoId?: string
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  initialName?: string
  initialPrompt?: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
  initialGitHubWorkItem?: GitHubWorkItem | null
  initialTaskSourceContext?: TaskSourceContext | null
  initialWorkspaceTarget?: WorkspaceCreationTargetHint | null
  initialWorkspaceStatus?: WorkspaceStatus
  initialBaseBranch?: string
  persistDraft: boolean
  onCreated?: () => void
  isSubmissionCancelled?: () => boolean
  repoIdOverride?: string
  onRepoIdOverrideChange?: (value: string) => void
  telemetrySource?: WorkspaceCreateTelemetrySource
  enableIssueAutomation?: boolean
}

export type ComposerCardProps = ComposerCardSourceProps &
  ComposerCardActionProps &
  ComposerAgentEntryCardProps

/** Multi-agent rows live beside the composer's source/action props; submit stays on `submitQuick`. */
export type ComposerAgentEntryCardProps = {
  agentEntries: ComposerAgentEntry[]
  onAgentEntryChange: (id: string, patch: Partial<ComposerAgentEntry>) => void
  onAddAgentEntry: () => void
  onRemoveAgentEntry: (id: string) => void
  agentEntriesLocked: boolean
}

export type UseComposerStateResult = {
  cardProps: ComposerCardProps
  composerRef: RefObject<HTMLDivElement | null>
  onComposerNodeChange: (node: HTMLDivElement | null) => void
  promptTextareaRef: RefObject<HTMLTextAreaElement | null>
  nameInputRef: RefObject<HTMLInputElement | null>
  submitQuick: (agent: TuiAgent | null, options?: QuickSubmitOptions) => Promise<void>
  createDisabled: boolean
  selectAddedProjectGroup: (groupId: string) => boolean
  selectAddedProjectRepo: (repoId: string) => void
}

const COMPOSER_DECISIONS: ComposerDecisions = {
  canResolveFolderSmartGitHubSubmit,
  getInitialAutoManagedWorkspaceName,
  getInitialGitHubPrStartPointSelection,
  getMatchingLinkedTaskSourceContext,
  isExplicitWorkspaceNameInput,
  resolveInitialWorkspaceRunSeed,
  resolveSmartGitHubCreateNames,
  retargetGitHubPrStartPointSelection
}

export function useComposerState(options: UseComposerStateOptions): UseComposerStateResult {
  const target = useComposerTargetState(options, COMPOSER_DECISIONS)
  // Row 0 starts on the default the modal's quick pick resolves before detection settles.
  const [agentEntries, setAgentEntries] = useState<ComposerAgentEntry[]>(() => {
    const { detectedAgentIds, disabledTuiAgents, tuiAgent } = target.workspaceIdentityState
    const agent = pickQuickWorkspaceAgent(tuiAgent, detectedAgentIds, disabledTuiAgents) ?? tuiAgent
    return [createComposerAgentEntry(agent)]
  })
  const onAgentEntryChange = useCallback((id: string, patch: Partial<ComposerAgentEntry>): void => {
    setAgentEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    )
  }, [])
  const onAddAgentEntry = useCallback((): void => {
    setAgentEntries((current) => {
      // Added rows repeat row 0's harness; repeated harnesses stay distinct through their ids.
      const agent = current[0]?.draft.agent ?? target.workspaceIdentityState.tuiAgent
      return current.length >= MAX_COMPOSER_AGENT_ROWS
        ? current
        : [...current, createComposerAgentEntry(agent)]
    })
  }, [target.workspaceIdentityState.tuiAgent])
  const onRemoveAgentEntry = useCallback((id: string): void => {
    // The list always keeps at least one row; the UI only offers removal while another row exists.
    setAgentEntries((current) =>
      current.length <= 1 ? current : current.filter((entry) => entry.id !== id)
    )
  }, [])
  const agentEntriesLocked =
    target.runtimeTargetSelection.isProjectGroupTarget ||
    target.runtimeTargetSelection.selectedWorkspaceTarget.status === 'ready' ||
    target.runtimeTargetSelection.selectedEphemeralVmRecipeId !== null
  const external = useComposerExternalSync(target)
  const source = useComposerSourceState(target, external)
  const submit = useComposerSubmitOrchestration(target, external, source)
  const model = assembleComposerModel(target, external, source, submit)
  const builtCard = buildComposerCardProps(model)
  const cardProps: ComposerCardProps = {
    ...builtCard.cardProps,
    agentEntries,
    onAgentEntryChange,
    onAddAgentEntry,
    onRemoveAgentEntry,
    agentEntriesLocked
  }
  const { createDisabled } = builtCard
  const modelSubmitQuick = model.submitQuick
  // The rows live beside the model, so submit must read them at call time rather than at assembly.
  const submitQuick = useCallback(
    (agent: TuiAgent | null, options?: QuickSubmitOptions): Promise<void> =>
      modelSubmitQuick(agent, options, { entries: agentEntries, locked: agentEntriesLocked }),
    [agentEntries, agentEntriesLocked, modelSubmitQuick]
  )
  return {
    cardProps,
    composerRef: model.composerRef,
    onComposerNodeChange: model.handleComposerNodeChange,
    promptTextareaRef: model.promptTextareaRef,
    nameInputRef: model.nameInputRef,
    submitQuick,
    createDisabled,
    selectAddedProjectRepo: model.selectAddedProjectRepo,
    selectAddedProjectGroup: model.selectAddedProjectGroup
  }
}
