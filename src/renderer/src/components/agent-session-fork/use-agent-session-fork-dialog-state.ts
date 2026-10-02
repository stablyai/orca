import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  copyTranscriptPrompt,
  runAgentSessionFork,
  type AgentSessionForkBase,
  type AgentSessionForkRequest,
  type AgentSessionForkSource
} from '@/lib/agent-session-fork-flow'
import { listForkableAgentSessions } from '@/lib/worktree-agent-fork-sessions'
import { translate } from '@/i18n/i18n'
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
import {
  claimAgentSessionForkSource,
  isAgentSessionForkSourceClaimed,
  releaseAgentSessionForkSource
} from './agent-session-fork-in-flight'
import {
  createAgentSessionForkProgressToast,
  type AgentSessionForkDialogStage
} from './agent-session-fork-progress-toast'

// Why: local forks finish before a spinner would read as progress; only slow (SSH) ones show stages.
const STAGE_LABEL_DELAY_MS = 200
const PARENT_COMMIT_BASE: AgentSessionForkBase = { kind: 'parent-commit' }

function isForkDialogActive(): boolean {
  return useAppStore.getState().activeModal === 'agent-session-fork'
}

function alreadyRunningMessage(workspace: string): string {
  return translate(
    'components.agentSessionFork.alreadyRunning',
    'A fork of {{workspace}} is already being created.',
    { workspace }
  )
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
  const [error, setError] = useState<string | null>(() =>
    isAgentSessionForkSourceClaimed(data.sourceWorktreeId)
      ? alreadyRunningMessage(source.label)
      : null
  )
  const busyRef = useRef(false)
  const flowRunningRef = useRef(false)
  const closedRef = useRef(false)
  const claimRef = useRef<symbol | null>(null)
  const mountedRef = useMountedRef()

  useEffect(() => {
    const sourceWorktreeId = data.sourceWorktreeId
    return () => {
      // Why: closed before the flow started means no fork will be created, so free the source now.
      const claim = claimRef.current
      if (claim && !flowRunningRef.current) {
        releaseAgentSessionForkSource(sourceWorktreeId, claim)
      }
    }
  }, [data.sourceWorktreeId])

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

  const runSubmit = useCallback(async (): Promise<void> => {
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
    const isShown = (): boolean => mountedRef.current && isForkDialogActive()
    const progress = createAgentSessionForkProgressToast(isShown)
    const outcome = await runAgentSessionFork(request, (next) => {
      setStage(next)
      progress.stage(next)
    }).catch((forkError: unknown) => ({
      ok: false as const,
      error: forkError instanceof Error ? forkError.message : String(forkError)
    }))
    const stillShown = isShown()
    resetBusy()
    if (!outcome.ok) {
      // Why: if another modal replaced this one mid-fork, the inline error would never be seen.
      if (stillShown) {
        setError(outcome.error)
      } else {
        progress.fail(outcome.error)
      }
      return
    }
    progress.succeed()
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
    readForSubmit,
    resetBusy,
    selectedOption,
    trimmedName
  ])

  const submit = useCallback(async (): Promise<void> => {
    if (busyRef.current || nameInvalid) {
      return
    }
    const claim = claimAgentSessionForkSource(data.sourceWorktreeId)
    if (!claim) {
      setError(alreadyRunningMessage(source.label))
      return
    }
    busyRef.current = true
    claimRef.current = claim
    try {
      await runSubmit()
    } finally {
      claimRef.current = null
      releaseAgentSessionForkSource(data.sourceWorktreeId, claim)
    }
  }, [data.sourceWorktreeId, nameInvalid, runSubmit, source.label])

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
