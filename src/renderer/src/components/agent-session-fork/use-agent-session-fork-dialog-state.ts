import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  copyTranscriptPrompt,
  runAgentSessionFork,
  type AgentSessionForkBase,
  type AgentSessionForkRequest,
  type AgentSessionForkSource,
  type AgentSessionForkStage
} from '@/lib/agent-session-fork-flow'
import { listForkableAgentSessions } from '@/lib/worktree-agent-fork-sessions'
import { slugifyForWorkspaceName } from '../../../../shared/workspace-name'
import type { AgentSessionForkModalData } from './agent-session-fork-modal-data'
import {
  agentSessionForkOptionKey,
  buildAgentSessionForkOptions,
  initialAgentSessionForkOptionKey,
  resolveSelectedAgentSessionForkOption
} from './agent-session-fork-options'
import { readForkSource, resolveCarryAvailability } from './agent-session-fork-parent-probe'
import { showAgentSessionForkWarnings } from './agent-session-fork-warning-toasts'
import { useAgentSessionForkParentStatus } from './use-agent-session-fork-parent-status'

// Why: local forks finish before a spinner would read as progress; only slow (SSH) ones show stages.
const STAGE_LABEL_DELAY_MS = 200
const PARENT_COMMIT_BASE: AgentSessionForkBase = { kind: 'parent-commit' }

/** `preparing` covers the wait for the parent's status, before anything is created. */
export type AgentSessionForkDialogStage = AgentSessionForkStage | 'preparing'

function isForkDialogActive(): boolean {
  return useAppStore.getState().activeModal === 'agent-session-fork'
}

export function useAgentSessionForkDialogState(data: AgentSessionForkModalData) {
  const closeModal = useAppStore((s) => s.closeModal)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const sleepingAgentSessionsByPaneKey = useAppStore((s) => s.sleepingAgentSessionsByPaneKey)
  const agentLaunchConfigByPaneKey = useAppStore((s) => s.agentLaunchConfigByPaneKey)
  const [source] = useState(() => readForkSource(data.sourceWorktreeId))

  const sessions = useMemo(
    () =>
      listForkableAgentSessions(
        {
          agentStatusByPaneKey,
          retainedAgentsByPaneKey,
          sleepingAgentSessionsByPaneKey,
          agentLaunchConfigByPaneKey
        },
        data.sourceWorktreeId
      ),
    [
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey,
      agentLaunchConfigByPaneKey,
      data.sourceWorktreeId
    ]
  )
  const options = useMemo(() => buildAgentSessionForkOptions(sessions, data), [sessions, data])
  const [selectedKey, setSelectedKey] = useState(() =>
    initialAgentSessionForkOptionKey(options, data.preselectedPaneKey)
  )
  const selectedOption = useMemo<AgentSessionForkSource>(
    () => resolveSelectedAgentSessionForkOption(options, selectedKey, data.preselectedPaneKey),
    [options, selectedKey, data.preselectedPaneKey]
  )

  const [name, setName] = useState(
    () => slugifyForWorkspaceName(`${source.label}-fork`) || 'session-fork'
  )
  const [asChild, setAsChild] = useState(true)
  const [carryChanges, setCarryChanges] = useState(true)
  const [base, setBase] = useState<AgentSessionForkBase>(PARENT_COMMIT_BASE)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const { changes, carrySupported, readForSubmit } = useAgentSessionForkParentStatus(source)
  const [busy, setBusy] = useState(false)
  const [flowRunning, setFlowRunning] = useState(false)
  const [stage, setStage] = useState<AgentSessionForkDialogStage | null>(null)
  const [stageVisible, setStageVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const flowRunningRef = useRef(false)
  const closedRef = useRef(false)
  const mountedRef = useMountedRef()

  useEffect(() => {
    if (!busy) {
      return
    }
    const timer = window.setTimeout(() => setStageVisible(true), STAGE_LABEL_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [busy])

  const carryAvailability = resolveCarryAvailability(changes, carrySupported, base)
  const trimmedName = name.trim()
  const nameInvalid = trimmedName.length === 0

  const resetBusy = useCallback((): void => {
    busyRef.current = false
    flowRunningRef.current = false
    setBusy(false)
    setFlowRunning(false)
    setStage(null)
    setStageVisible(false)
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    if (busyRef.current || nameInvalid) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    setStage('preparing')
    // Why: the parent may have committed since the dialog opened; fork from its HEAD as of submit.
    const parent = await readForSubmit()
    // Why: nothing exists yet, so a cancel (or another modal) during the wait must not create a fork.
    if (closedRef.current || !mountedRef.current || !isForkDialogActive()) {
      resetBusy()
      return
    }
    const probedCarry = resolveCarryAvailability(parent.changes, parent.carrySupported, base)
    const request: AgentSessionForkRequest = {
      sourceWorktreeId: data.sourceWorktreeId,
      name: trimmedName,
      source: selectedOption,
      asChild,
      carryChanges: carryChanges && probedCarry === 'available',
      sourceHeadOid: parent.changes?.headOid ?? null,
      base,
      launchSource: data.launchSource
    }
    flowRunningRef.current = true
    setFlowRunning(true)
    const outcome = await runAgentSessionFork(request, setStage).catch((forkError: unknown) => ({
      ok: false as const,
      error: forkError instanceof Error ? forkError.message : String(forkError)
    }))
    const stillShown = mountedRef.current && isForkDialogActive()
    resetBusy()
    if (!outcome.ok) {
      // Why: if another modal replaced this one mid-fork, the inline error would never be seen.
      if (stillShown) {
        setError(outcome.error)
      } else {
        toast.error(outcome.error)
      }
      return
    }
    if (stillShown) {
      closeModal()
    }
    showAgentSessionForkWarnings(outcome.warnings, request.name, request.source)
  }, [
    asChild,
    base,
    carryChanges,
    closeModal,
    data.launchSource,
    data.sourceWorktreeId,
    mountedRef,
    nameInvalid,
    readForSubmit,
    resetBusy,
    selectedOption,
    trimmedName
  ])

  // Why: an unrecognised pane agent has no transcript launch, but its context can still be copied.
  const copyablePrompt =
    selectedOption.kind === 'transcript'
      ? selectedOption.prompt
      : data.transcript?.agent === null
        ? data.transcript.prompt
        : null
  const copyContext = useCallback(async (): Promise<void> => {
    if (copyablePrompt !== null && (await copyTranscriptPrompt(copyablePrompt))) {
      closeModal()
    }
  }, [closeModal, copyablePrompt])

  const close = useCallback((): void => {
    // Why: once the flow runs, closing would hide a fork that is still being created.
    if (!flowRunningRef.current) {
      closedRef.current = true
      closeModal()
    }
  }, [closeModal])

  return {
    source,
    options,
    selectedKey: agentSessionForkOptionKey(selectedOption),
    setSelectedKey,
    selectedOption,
    showSessionField: options.length !== 2,
    name,
    setName,
    nameInvalid,
    asChild,
    setAsChild,
    carryChanges,
    setCarryChanges,
    carryAvailability,
    parentCommitShort: changes?.headOid ? changes.headOid.slice(0, 7) : null,
    modifiedCount: changes?.modified ?? 0,
    newCount: changes?.added ?? 0,
    base,
    setBase,
    advancedOpen,
    setAdvancedOpen,
    busy,
    flowRunning,
    visibleStage: busy && stageVisible ? stage : null,
    error,
    submit,
    canCopyContext: copyablePrompt !== null,
    copyContext,
    close
  }
}
