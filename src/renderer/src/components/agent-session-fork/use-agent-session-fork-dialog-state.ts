import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
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
  initialAgentSessionForkOptionKey
} from './agent-session-fork-options'
import {
  probeParentWorkingTree,
  readForkSource,
  resolveCarryAvailability,
  type ParentProbe,
  type ParentWorkingTreeChanges
} from './agent-session-fork-parent-probe'
import { showAgentSessionForkWarnings } from './agent-session-fork-warning-toasts'

// Why: local forks finish before a spinner would read as progress; only slow (SSH) ones show stages.
const STAGE_LABEL_DELAY_MS = 200
const PARENT_COMMIT_BASE: AgentSessionForkBase = { kind: 'parent-commit' }

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
  // Why: a session can vanish while the dialog is open; fall back to "No agent", never a stale one.
  const selectedOption = useMemo<AgentSessionForkSource>(
    () =>
      options.find((option) => agentSessionForkOptionKey(option) === selectedKey) ?? {
        kind: 'none'
      },
    [options, selectedKey]
  )

  const [name, setName] = useState(
    () => slugifyForWorkspaceName(`${source.label}-fork`) || 'session-fork'
  )
  const [asChild, setAsChild] = useState(true)
  const [carryChanges, setCarryChanges] = useState(true)
  const [base, setBase] = useState<AgentSessionForkBase>(PARENT_COMMIT_BASE)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [changes, setChanges] = useState<ParentWorkingTreeChanges | null>(null)
  const [carrySupported, setCarrySupported] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<AgentSessionForkStage | null>(null)
  const [stageVisible, setStageVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const probeRef = useRef<ParentProbe | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const probe = probeParentWorkingTree(source, controller.signal)
    probeRef.current = probe
    void probe.changes.then((probed) => {
      if (!controller.signal.aborted) {
        setChanges(probed)
      }
    })
    void probe.carrySupported.then((supported) => {
      if (!controller.signal.aborted) {
        setCarrySupported(supported)
      }
    })
    return () => controller.abort()
  }, [source])

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

  const submit = useCallback(async (): Promise<void> => {
    if (busyRef.current || nameInvalid) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    // Why: the wait reads as the first stage, and a fast Enter must not skip the parent's HEAD.
    setStage('creating')
    const probe = probeRef.current
    const [probedChanges, probedCarrySupported] = await Promise.all([
      probe?.changes ?? null,
      probe?.carrySupported ?? false
    ])
    const probedCarry = resolveCarryAvailability(probedChanges, probedCarrySupported, base)
    const request: AgentSessionForkRequest = {
      sourceWorktreeId: data.sourceWorktreeId,
      name: trimmedName,
      source: selectedOption,
      asChild,
      carryChanges: carryChanges && probedCarry === 'available',
      sourceHeadOid: probedChanges?.headOid ?? null,
      base,
      launchSource: data.launchSource
    }
    const outcome = await runAgentSessionFork(request, setStage).catch((forkError: unknown) => ({
      ok: false as const,
      error: forkError instanceof Error ? forkError.message : String(forkError)
    }))
    busyRef.current = false
    if (!outcome.ok) {
      setBusy(false)
      setStage(null)
      setStageVisible(false)
      setError(outcome.error)
      return
    }
    closeModal()
    showAgentSessionForkWarnings(outcome.warnings, request.name, request.source)
  }, [
    asChild,
    base,
    carryChanges,
    closeModal,
    data.launchSource,
    data.sourceWorktreeId,
    nameInvalid,
    selectedOption,
    trimmedName
  ])

  const copyContext = useCallback(async (): Promise<void> => {
    if (
      selectedOption.kind === 'transcript' &&
      (await copyTranscriptPrompt(selectedOption.prompt))
    ) {
      closeModal()
    }
  }, [closeModal, selectedOption])

  const close = useCallback((): void => {
    if (!busyRef.current) {
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
    modifiedCount: changes?.modified ?? 0,
    newCount: changes?.added ?? 0,
    base,
    setBase,
    advancedOpen,
    setAdvancedOpen,
    busy,
    visibleStage: busy && stageVisible ? stage : null,
    error,
    submit,
    copyContext,
    close
  }
}
