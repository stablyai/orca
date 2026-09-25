import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { settingsForRepoOwner } from '@/store/repos/owner-routing'
import {
  copyTranscriptPrompt,
  runAgentSessionFork,
  type AgentSessionForkRequest,
  type AgentSessionForkSource,
  type AgentSessionForkStage
} from '@/lib/agent-session-fork-flow'
import { listForkableAgentSessions } from '@/lib/worktree-agent-fork-sessions'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { isWorkingTreeCarrySupported } from '@/runtime/runtime-git-working-tree-carry-client'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import { slugifyForWorkspaceName } from '../../../../shared/workspace-name'
import type { AgentSessionForkModalData } from './agent-session-fork-modal-data'
import {
  agentSessionForkOptionKey,
  buildAgentSessionForkOptions,
  initialAgentSessionForkOptionKey
} from './agent-session-fork-options'
import { showAgentSessionForkWarnings } from './agent-session-fork-warning-toasts'

export type AgentSessionForkCarryAvailability =
  | 'hidden'
  | 'available'
  | 'other-base'
  | 'unsupported'

type WorkingTreeChanges = { modified: number; added: number; headOid: string | null }

const HEAD_OID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/
// Why: local forks finish before a spinner would read as progress; only slow (SSH) ones show stages.
const STAGE_LABEL_DELAY_MS = 200

function shortBranchName(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim()
  return trimmed ? trimmed.replace(/^refs\/heads\//, '') : null
}

function countWorkingTreeChanges(status: GitStatusResult): WorkingTreeChanges {
  const modified = new Set<string>()
  const added = new Set<string>()
  for (const entry of status.entries) {
    if (entry.area === 'untracked') {
      added.add(entry.path)
    } else {
      modified.add(entry.path)
    }
  }
  const head = status.head ?? ''
  return {
    modified: modified.size,
    added: added.size,
    headOid: HEAD_OID_PATTERN.test(head) ? head : null
  }
}

function resolveCarryAvailability(
  changes: WorkingTreeChanges | null,
  carrySupported: boolean | null,
  baseBranchOverride: string | null
): AgentSessionForkCarryAvailability {
  // Why: wait for the capability probe so the switch never flips from enabled to disabled.
  if (!changes?.headOid || changes.modified + changes.added === 0 || carrySupported === null) {
    return 'hidden'
  }
  if (baseBranchOverride !== null) {
    return 'other-base'
  }
  return carrySupported ? 'available' : 'unsupported'
}

type ForkSourceSnapshot = {
  worktree: { id: string; repoId: string; path: string } | null
  connectionId: string | null
  settings: ReturnType<typeof settingsForRepoOwner>
  parentBranch: string | null
  label: string
}

function readForkSource(sourceWorktreeId: string): ForkSourceSnapshot {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(sourceWorktreeId) ?? null
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : undefined
  const parentBranch = shortBranchName(worktree?.branch)
  return {
    worktree,
    connectionId: repo?.connectionId ?? null,
    // Why: the same owner routing the fork flow uses, so status and carry probe the child's host.
    settings: worktree ? settingsForRepoOwner(state, worktree.repoId) : state.settings,
    parentBranch,
    label: worktree?.displayName?.trim() || parentBranch || sourceWorktreeId
  }
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
  const [baseBranchOverride, setBaseBranchOverride] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [changes, setChanges] = useState<WorkingTreeChanges | null>(null)
  const [carrySupported, setCarrySupported] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<AgentSessionForkStage | null>(null)
  const [stageVisible, setStageVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    const { worktree } = source
    if (!worktree) {
      return
    }
    const controller = new AbortController()
    getRuntimeGitStatus(
      {
        settings: source.settings,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        connectionId: source.connectionId ?? undefined
      },
      { admissionTier: 'interactive', includeLineStats: false, signal: controller.signal }
    )
      .then((status) => {
        if (!controller.signal.aborted) {
          setChanges(countWorkingTreeChanges(status))
        }
      })
      .catch((statusError: unknown) => {
        // Why: without a status the fork still works; it just starts clean at the parent branch.
        console.warn('[agent-session-fork] reading parent changes failed', statusError)
      })
    isWorkingTreeCarrySupported(source.settings)
      .catch(() => false)
      .then((supported) => {
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

  const carryAvailability = resolveCarryAvailability(changes, carrySupported, baseBranchOverride)
  const trimmedName = name.trim()
  const nameInvalid = trimmedName.length === 0

  const submit = useCallback(async (): Promise<void> => {
    if (busyRef.current || nameInvalid) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    const request: AgentSessionForkRequest = {
      sourceWorktreeId: data.sourceWorktreeId,
      name: trimmedName,
      source: selectedOption,
      asChild,
      carryChanges: carryChanges && carryAvailability === 'available',
      sourceHeadOid: changes?.headOid ?? null,
      baseBranchOverride,
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
    baseBranchOverride,
    carryAvailability,
    carryChanges,
    changes,
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
    baseBranchOverride,
    setBaseBranchOverride,
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
