import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { useBots } from '@/lib/bot-catalog'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { AgentJournalWorkTarget } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { agentSessionWriteNoticeText } from '../../messages/notices/agent-session-write-notice-text'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import { buildBotWorkTargetTree, type BotWorkTargetTreeRow } from './bot-work-target-tree'

/** Subscribe to the current composer draft's selected project/workspace target. */
export function useNativeChatComposerWorkTarget(scopeKey: string): {
  workTarget: AgentJournalWorkTarget | null
  setWorkTarget: (target: AgentJournalWorkTarget | null) => void
} {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(scopeKey, listener),
    [scopeKey]
  )
  const workTarget = useSyncExternalStore(
    subscribe,
    () => readNativeChatComposerDraft(scopeKey).workTarget ?? null
  )
  const setWorkTarget = useCallback(
    (target: AgentJournalWorkTarget | null) => {
      updateNativeChatComposerDraft(scopeKey, { workTarget: target }, 'immediate')
    },
    [scopeKey]
  )
  return { workTarget, setWorkTarget }
}

/** Own picker open state, unsupported-host notice, and props bundle for the composer pane. */
export function useNativeChatComposerWorkTargetPicker(
  draftScopeKey: string,
  support: NativeChatStructuredComposerTransport['workTargetSupport'],
  disabled: boolean,
  setNotice: (notice: string | null) => void
) {
  const { workTarget, setWorkTarget } = useNativeChatComposerWorkTarget(draftScopeKey)
  const [open, setOpen] = useState(false)
  const openPicker = useCallback(() => {
    if (!support || disabled) {
      return
    }
    if (!support.supported) {
      setNotice(agentSessionWriteNoticeText(['workTargetHostUnsupported']))
      return
    }
    setOpen(true)
  }, [disabled, setNotice, support])

  const pickerProps = support
    ? {
        open,
        onOpenChange: setOpen,
        botHostId: support.botHostId,
        supported: support.supported,
        selectedTarget: workTarget,
        onSelectTarget: setWorkTarget
      }
    : undefined

  return {
    onOpenWorkTargetPicker: support ? openPicker : undefined,
    workTargetPicker: pickerProps
  }
}

/** Live project & workspace tree for the bot chat target picker; computed only while open. */
export function useBotWorkTargetCatalog(
  botHostId: ExecutionHostId | null,
  enabled: boolean
): readonly BotWorkTargetTreeRow[] {
  const repos = useAppStore((state) => state.repos)
  const projects = useAppStore((state) => state.projects)
  const projectHostSetups = useAppStore((state) => state.projectHostSetups)
  const worktreesByRepo = useAppStore((state) => selectWorktreesByRepo(state))
  const worktreeLineageById = useAppStore((state) => state.worktreeLineageById)
  const folderWorkspaces = useAppStore((state) => selectFolderWorkspaces(state))
  const projectGroups = useAppStore((state) => state.projectGroups)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const sshConnectionStates = useAppStore((state) => state.sshConnectionStates)
  const runtimeStatusByEnvironmentId = useRuntimeStatusByEnvironmentId()
  const bots = useBots(enabled && botHostId !== null)

  return useMemo(() => {
    if (!enabled || botHostId === null) {
      return []
    }
    return buildBotWorkTargetTree({
      botHostId,
      repos,
      projects,
      projectHostSetups,
      worktreesByRepo,
      worktreeLineageById,
      folderWorkspaces,
      projectGroups,
      bots,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      sshTargetLabels,
      sshConnectionStates
    })
  }, [
    botHostId,
    bots,
    enabled,
    folderWorkspaces,
    projectGroups,
    projectHostSetups,
    projects,
    repos,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    sshConnectionStates,
    sshTargetLabels,
    worktreeLineageById,
    worktreesByRepo
  ])
}
