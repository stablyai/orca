/* eslint-disable max-lines -- Why: this page owns the automations list/detail
 * orchestration while the form and detail presentation live in sibling files. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, Check, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useRepoMap, useWorktreeMap } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type {
  Automation,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/types'
import { buildAutomationRrule, parseAutomationRrule } from '../../../../shared/automation-schedules'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'
import {
  formatAutomationCost,
  formatAutomationTokens,
  summarizeAutomationRunUsage
} from './automation-usage-model'
import { AutomationDetail } from './AutomationDetail'
import { AutomationEditorDialog, type AutomationDraft } from './AutomationEditorDialog'
import { ExternalAutomationManagers } from './ExternalAutomationManagers'

const AGENTS = AGENT_CATALOG.map((agent) => agent.id)
const DEFAULT_TIME = '09:00'
const AUTOMATIONS_CHANGED_EVENT = 'orca:automations-changed'

function getDefaultWorktree(worktrees: readonly Worktree[]): Worktree | null {
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0] ?? null
}

function formatTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export default function AutomationsPage(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const settings = useAppStore((s) => s.settings)
  const selectedId = useAppStore((s) => s.selectedAutomationId)
  const setSelectedId = useAppStore((s) => s.setSelectedAutomationId)
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const defaultAgent =
    settings?.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : AGENTS[0]

  const [automations, setAutomations] = useState<Automation[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [externalManagers, setExternalManagers] = useState<ExternalAutomationManager[]>([])
  const [externalActionKey, setExternalActionKey] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editingAutomationId, setEditingAutomationId] = useState<string | null>(null)
  const [relativeNow, setRelativeNow] = useState(Date.now())
  const [draftAtOpen, setDraftAtOpen] = useState<AutomationDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null)
  const [externalDeleteTarget, setExternalDeleteTarget] = useState<{
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
  } | null>(null)
  const [dontAskDeleteAgain, setDontAskDeleteAgain] = useState(false)
  const editRequestRef = useRef(0)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState<AutomationDraft>({
    name: '',
    prompt: '',
    agentId: defaultAgent,
    projectId: '',
    workspaceMode: 'existing',
    workspaceId: '',
    baseBranch: '',
    preset: 'weekdays',
    time: DEFAULT_TIME,
    dayOfWeek: '1',
    missedRunGraceMinutes: '720'
  })

  const selected =
    automations.find((automation) => automation.id === selectedId) ?? automations[0] ?? null
  const selectedRuns = runs.filter((run) => run.automationId === selected?.id)
  const worktrees = useMemo(
    () => worktreesByRepo[draft.projectId] ?? [],
    [draft.projectId, worktreesByRepo]
  )
  const selectedRepo = selected ? (repoMap.get(selected.projectId) ?? null) : null
  const selectedWorktree =
    selected && selected.workspaceId ? (worktreeMap.get(selected.workspaceId) ?? null) : null
  const canSaveDraft =
    editingAutomationId === null ||
    !draftAtOpen ||
    JSON.stringify(draft) !== JSON.stringify(draftAtOpen)

  const getDefaultTarget = useCallback(() => {
    const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null
    const activeRepo = activeWorktree ? (repoMap.get(activeWorktree.repoId) ?? null) : null
    const fallbackRepo = activeRepo ?? repos[0] ?? null
    const fallbackWorktrees = fallbackRepo ? (worktreesByRepo[fallbackRepo.id] ?? []) : []
    // Why: automation-created workspaces can be active; new automations should start from
    // the repo's stable main worktree unless the user explicitly chooses otherwise.
    const targetWorktree = getDefaultWorktree(fallbackWorktrees) ?? activeWorktree
    const targetProjectId = fallbackRepo?.id ?? targetWorktree?.repoId ?? ''
    return {
      projectId: targetProjectId,
      workspaceId: targetWorktree?.id ?? ''
    }
  }, [activeWorktreeId, repoMap, repos, worktreeMap, worktreesByRepo])

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const [nextAutomations, nextRuns, nextExternalManagers] = await Promise.all([
        window.api.automations.list(),
        window.api.automations.listRuns(),
        window.api.automations.listExternalManagers()
      ])
      setAutomations(nextAutomations)
      setRuns(nextRuns)
      setExternalManagers(nextExternalManagers)
      const currentSelectedId = useAppStore.getState().selectedAutomationId
      const hasCurrentSelection = nextAutomations.some(
        (automation) => automation.id === currentSelectedId
      )
      if (!hasCurrentSelection) {
        setSelectedId(nextAutomations[0]?.id ?? null)
      }
    } finally {
      setIsLoading(false)
    }
  }, [setSelectedId])

  useEffect(() => {
    void fetchAllWorktrees()
    void refresh()
  }, [fetchAllWorktrees, refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeNow(Date.now()), 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onAutomationsChanged = (): void => {
      void refresh()
    }
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
    return () => window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
  }, [refresh])

  useEffect(() => {
    const completedRuns = runs.filter((run) => {
      if (run.status !== 'dispatched' || !run.terminalSessionId) {
        return false
      }
      const paneKeyPrefix = `${run.terminalSessionId}:`
      const liveDone = Object.entries(agentStatusByPaneKey).some(
        ([paneKey, entry]) => paneKey.startsWith(paneKeyPrefix) && entry.state === 'done'
      )
      if (liveDone) {
        return true
      }
      return Object.entries(retainedAgentsByPaneKey).some(
        ([paneKey, retained]) =>
          paneKey.startsWith(paneKeyPrefix) && retained.entry.state === 'done'
      )
    })
    if (completedRuns.length === 0) {
      return
    }
    void Promise.all(
      completedRuns.map((run) =>
        window.api.automations.markDispatchResult({
          runId: run.id,
          status: 'completed',
          workspaceId: run.workspaceId,
          terminalSessionId: run.terminalSessionId,
          error: null
        })
      )
    ).then(() => refresh())
  }, [agentStatusByPaneKey, retainedAgentsByPaneKey, refresh, runs])

  useEffect(() => {
    if (!draft.projectId) {
      const target = getDefaultTarget()
      if (!target.projectId) {
        return
      }
      setDraft((current) => ({
        ...current,
        projectId: target.projectId,
        workspaceId: target.workspaceId
      }))
    }
  }, [draft.projectId, getDefaultTarget])

  useEffect(() => {
    if (!draft.projectId) {
      return
    }
    const available = worktreesByRepo[draft.projectId] ?? []
    const defaultWorktree = getDefaultWorktree(available)
    if (!draft.workspaceId && defaultWorktree) {
      setDraft((current) => ({ ...current, workspaceId: defaultWorktree.id }))
    }
  }, [draft.projectId, draft.workspaceId, worktreesByRepo])

  const openCreateDialog = (): void => {
    editRequestRef.current += 1
    const target = getDefaultTarget()
    setEditingAutomationId(null)
    const nextDraft: AutomationDraft = {
      name: '',
      prompt: '',
      agentId: defaultAgent,
      projectId: target.projectId,
      workspaceMode: 'existing',
      workspaceId: target.workspaceId,
      baseBranch: '',
      preset: 'weekdays',
      time: DEFAULT_TIME,
      dayOfWeek: '1',
      missedRunGraceMinutes: '720'
    }
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setCreateOpen(true)
  }

  const openEditDialog = async (automation: Automation): Promise<void> => {
    const requestId = (editRequestRef.current += 1)
    let latest = automation
    try {
      latest =
        (await window.api.automations.list()).find((entry) => entry.id === automation.id) ??
        automation
    } catch {
      latest = automation
    }
    if (requestId !== editRequestRef.current) {
      return
    }
    const schedule = parseAutomationRrule(latest.rrule)
    setEditingAutomationId(latest.id)
    const nextDraft: AutomationDraft = {
      name: latest.name,
      prompt: latest.prompt,
      agentId: latest.agentId,
      projectId: latest.projectId,
      workspaceMode: latest.workspaceMode,
      workspaceId: latest.workspaceId ?? '',
      baseBranch: latest.baseBranch ?? '',
      preset: schedule.preset,
      time: formatTimeInput(schedule.hour, schedule.minute),
      dayOfWeek: String(schedule.dayOfWeek),
      missedRunGraceMinutes: String(latest.missedRunGraceMinutes)
    }
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setCreateOpen(true)
  }

  const handleProjectChange = useCallback(
    (projectId: string): void => {
      const currentWorktrees = worktreesByRepo[projectId] ?? []
      const currentDefaultWorktree = getDefaultWorktree(currentWorktrees)
      setDraft((current) => ({
        ...current,
        projectId,
        workspaceId: currentDefaultWorktree?.id ?? '',
        baseBranch: ''
      }))

      void fetchWorktrees(projectId).then(() => {
        const latestWorktrees = useAppStore.getState().worktreesByRepo[projectId] ?? []
        const latestWorktree = getDefaultWorktree(latestWorktrees)
        if (!latestWorktree) {
          return
        }
        // Why: project worktrees may not be loaded when the repo picker changes.
        // Select after fetching so saving does not fail on an empty workspace id.
        setDraft((current) =>
          current.projectId === projectId && !current.workspaceId
            ? { ...current, workspaceId: latestWorktree.id }
            : current
        )
      })
    },
    [fetchWorktrees, worktreesByRepo]
  )

  const saveAutomation = async (): Promise<void> => {
    const [hour, minute] = draft.time.split(':').map((part) => Number(part))
    if (
      !draft.projectId ||
      (draft.workspaceMode === 'existing' && !draft.workspaceId) ||
      !draft.prompt.trim()
    ) {
      toast.error('Choose a run location and enter a prompt before saving.')
      return
    }
    setIsSaving(true)
    try {
      const selectedWorkspaceExists =
        draft.workspaceMode !== 'existing' ||
        worktrees.some((worktree) => worktree.id === draft.workspaceId)
      if (!selectedWorkspaceExists) {
        toast.error('Choose an available workspace before saving.')
        return
      }
      const now = Date.now()
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const rrule = buildAutomationRrule({
        preset: draft.preset,
        hour: Number.isFinite(hour) ? hour : 9,
        minute: Number.isFinite(minute) ? minute : 0,
        dayOfWeek: Number(draft.dayOfWeek)
      })
      const rawMissedRunGraceMinutes = Number(draft.missedRunGraceMinutes)
      const missedRunGraceMinutes = Number.isFinite(rawMissedRunGraceMinutes)
        ? Math.max(0, rawMissedRunGraceMinutes)
        : 720
      let currentAutomation = editingAutomationId
        ? (automations.find((automation) => automation.id === editingAutomationId) ?? null)
        : null
      if (editingAutomationId) {
        try {
          currentAutomation =
            (await window.api.automations.list()).find(
              (automation) => automation.id === editingAutomationId
            ) ?? currentAutomation
        } catch {
          // Keep the in-memory automation as a fallback if the refresh fails.
        }
      }
      const updates: AutomationUpdateInput = {
        name: draft.name,
        prompt: draft.prompt,
        agentId: draft.agentId,
        projectId: draft.projectId,
        workspaceMode: draft.workspaceMode,
        workspaceId: draft.workspaceId,
        baseBranch: draft.baseBranch.trim() || null,
        timezone,
        missedRunGraceMinutes
      }
      if (!currentAutomation || currentAutomation.rrule !== rrule) {
        // Why: non-schedule edits should not reset dtstart or move nextRunAt.
        updates.rrule = rrule
        updates.dtstart = now
      }
      const automation = editingAutomationId
        ? await window.api.automations.update({
            id: editingAutomationId,
            updates
          })
        : await window.api.automations.create({
            name: draft.name,
            prompt: draft.prompt,
            agentId: draft.agentId,
            projectId: draft.projectId,
            workspaceMode: draft.workspaceMode,
            workspaceId: draft.workspaceId,
            baseBranch: draft.baseBranch.trim() || null,
            timezone,
            rrule,
            dtstart: now,
            missedRunGraceMinutes
          })
      setAutomations((current) => {
        const next = current.filter((entry) => entry.id !== automation.id)
        return [...next, automation].sort((left, right) => left.name.localeCompare(right.name))
      })
      setDraft((current) => ({ ...current, name: '', prompt: '' }))
      await refresh()
      setSelectedId(automation.id)
      setCreateOpen(false)
      toast.success(editingAutomationId ? 'Automation updated.' : 'Automation saved.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save automation.')
    } finally {
      setIsSaving(false)
    }
  }

  const toggleAutomation = async (automation: Automation): Promise<void> => {
    await window.api.automations.update({
      id: automation.id,
      updates: { enabled: !automation.enabled }
    })
    await refresh()
  }

  const deleteAutomation = async (automation: Automation): Promise<void> => {
    await window.api.automations.delete({ id: automation.id })
    if (useAppStore.getState().selectedAutomationId === automation.id) {
      setSelectedId(null)
    }
    await refresh()
  }

  const persistDeleteAutomationPreference = (): void => {
    void updateSettings({ skipDeleteAutomationConfirm: true })
    toast.success("We'll skip this confirmation next time.", {
      description: 'You can change this in Settings.',
      duration: 8000,
      action: {
        label: 'Open Settings',
        onClick: () => {
          openSettingsPage()
          openSettingsTarget({
            pane: 'general',
            repoId: null,
            sectionId: 'general-skip-delete-automation-confirm'
          })
        }
      }
    })
  }

  const requestDeleteAutomation = (automation: Automation): void => {
    if (settings?.skipDeleteAutomationConfirm) {
      void deleteAutomation(automation)
      return
    }
    setDontAskDeleteAgain(false)
    setDeleteTarget(automation)
  }

  const confirmDeleteAutomation = async (): Promise<void> => {
    if (!deleteTarget) {
      return
    }
    if (dontAskDeleteAgain) {
      persistDeleteAutomationPreference()
    }
    const target = deleteTarget
    setDeleteTarget(null)
    setDontAskDeleteAgain(false)
    await deleteAutomation(target)
  }

  const runNow = async (automation: Automation): Promise<void> => {
    await window.api.automations.runNow({ id: automation.id })
    await refresh()
    toast.message('Automation run queued.')
  }

  const runExternalAction = async (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ): Promise<void> => {
    const key = `${manager.id}:${job.id}:${action}`
    setExternalActionKey(key)
    try {
      await window.api.automations.runExternalAction({
        managerId: manager.id,
        provider: manager.provider,
        target: manager.target,
        jobId: job.id,
        action
      })
      await refresh()
      toast.success(
        action === 'delete'
          ? 'External automation deleted.'
          : action === 'run'
            ? 'External automation queued.'
            : action === 'pause'
              ? 'External automation paused.'
              : 'External automation resumed.'
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'External automation action failed.')
    } finally {
      setExternalActionKey(null)
    }
  }

  const requestExternalAction = (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ): void => {
    if (action === 'delete') {
      setExternalDeleteTarget({ manager, job })
      return
    }
    void runExternalAction(manager, job, action)
  }

  const confirmDeleteExternalAutomation = async (): Promise<void> => {
    if (!externalDeleteTarget) {
      return
    }
    const target = externalDeleteTarget
    setExternalDeleteTarget(null)
    await runExternalAction(target.manager, target.job, 'delete')
  }

  const openRunWorkspace = (run: AutomationRun): void => {
    if (!run.workspaceId || !activateAndRevealWorktree(run.workspaceId)) {
      toast.error('Workspace is not available.')
      return
    }
    if (run.terminalSessionId) {
      const store = useAppStore.getState()
      if (store.getTab(run.terminalSessionId)) {
        store.setActiveTab(run.terminalSessionId)
        store.setActiveTabType('terminal')
      }
    }
  }

  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-1.5 md:px-8">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Automations</h1>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh automations"
                onClick={refresh}
                disabled={isLoading}
                className="border border-border/50 bg-transparent hover:bg-muted/50"
              >
                <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Refresh automations
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Add automation"
                onClick={openCreateDialog}
                className="border border-border/50 bg-transparent hover:bg-muted/50"
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Add automation
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      <AutomationEditorDialog
        open={createOpen}
        isEditing={editingAutomationId !== null}
        isSaving={isSaving}
        canSave={canSaveDraft}
        repos={repos}
        repoMap={repoMap}
        worktrees={worktrees}
        settings={settings}
        draft={draft}
        onProjectChange={handleProjectChange}
        onOpenChange={setCreateOpen}
        onDraftChange={setDraft}
        onSave={() => void saveAutomation()}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (open) {
            return
          }
          setDeleteTarget(null)
          setDontAskDeleteAgain(false)
        }}
      >
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            deleteConfirmButtonRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Delete Automation</DialogTitle>
            <DialogDescription className="text-xs">
              Delete{' '}
              <span className="break-all font-medium text-foreground">{deleteTarget?.name}</span>{' '}
              and its run history. Workspaces created by previous runs are not deleted.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all font-medium text-foreground">{deleteTarget.name}</div>
              <div className="mt-1 text-muted-foreground">
                {deleteTarget.workspaceMode === 'new_per_run'
                  ? 'New workspace each run'
                  : 'Selected workspace'}
              </div>
            </div>
          ) : null}
          <button
            type="button"
            role="checkbox"
            aria-checked={dontAskDeleteAgain}
            onClick={() => setDontAskDeleteAgain((prev) => !prev)}
            className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
                dontAskDeleteAgain
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-muted-foreground bg-transparent'
              }`}
            >
              {dontAskDeleteAgain ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>
            Don&apos;t ask again
          </button>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteTarget(null)
                setDontAskDeleteAgain(false)
              }}
            >
              Cancel
            </Button>
            <Button
              ref={deleteConfirmButtonRef}
              variant="destructive"
              onClick={() => void confirmDeleteAutomation()}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={externalDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExternalDeleteTarget(null)
          }
        }}
      >
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            deleteConfirmButtonRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Delete External Automation</DialogTitle>
            <DialogDescription className="text-xs">
              Delete{' '}
              <span className="break-all font-medium text-foreground">
                {externalDeleteTarget?.job.name}
              </span>{' '}
              from {externalDeleteTarget?.manager.label}.
            </DialogDescription>
          </DialogHeader>
          {externalDeleteTarget ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all font-medium text-foreground">
                {externalDeleteTarget.job.name}
              </div>
              <div className="mt-1 text-muted-foreground">{externalDeleteTarget.job.schedule}</div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setExternalDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              ref={deleteConfirmButtonRef}
              variant="destructive"
              onClick={() => void confirmDeleteExternalAutomation()}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_1fr] overflow-hidden border-t border-border/50">
        <section className="flex min-h-0 flex-col border-r border-border/50 bg-muted/20">
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {automations.map((automation) => {
              const automationRepo = repoMap.get(automation.projectId)
              const automationWorktree = automation.workspaceId
                ? worktreeMap.get(automation.workspaceId)
                : null
              const workspaceLabel =
                automation.workspaceMode === 'new_per_run'
                  ? 'New workspace each run'
                  : (automationWorktree?.displayName ?? 'Missing workspace')
              const usageSummary = summarizeAutomationRunUsage(
                runs.filter((run) => run.automationId === automation.id)
              )
              const usageText =
                usageSummary.knownRuns > 0
                  ? `${formatAutomationCost(
                      usageSummary.estimatedCostUsd
                    )} est. · ${formatAutomationTokens(usageSummary.totalTokens)} tokens`
                  : usageSummary.unavailableRuns > 0
                    ? 'Usage unavailable'
                    : 'No run usage yet'
              return (
                <ContextMenu key={automation.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setSelectedId(automation.id)}
                      className={cn(
                        'mb-1 flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        selected?.id === automation.id
                          ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
                          : 'border-transparent hover:bg-muted/50'
                      )}
                    >
                      <span className="font-medium">{automation.name}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {automationRepo ? (
                          <RepoDotLabel
                            name={automationRepo.displayName}
                            color={automationRepo.badgeColor}
                            dotClassName="size-1.5"
                          />
                        ) : (
                          <span>Unknown project</span>
                        )}
                        <span className="shrink-0">/</span>
                        <span className="truncate">{workspaceLabel}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {automation.enabled
                          ? `Next run ${formatAutomationDateTimeWithRelative(
                              automation.nextRunAt,
                              relativeNow
                            )}`
                          : 'Paused'}
                      </span>
                      <span className="text-xs text-muted-foreground">{usageText}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => void runNow(automation)}>
                      <Play className="size-3.5" />
                      Run Now
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void openEditDialog(automation)}>
                      <Pencil className="size-3.5" />
                      Edit
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void toggleAutomation(automation)}>
                      {automation.enabled ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {automation.enabled ? 'Pause' : 'Resume'}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => requestDeleteAutomation(automation)}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
            {automations.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No automations yet.</div>
            ) : null}
          </div>
        </section>

        <section className="min-h-0 overflow-auto p-5">
          <AutomationDetail
            automation={selected}
            runs={selectedRuns}
            projectName={selectedRepo?.displayName ?? 'Unknown project'}
            projectDefaultBaseRef={selectedRepo?.worktreeBaseRef ?? null}
            workspaceName={
              selected?.workspaceMode === 'new_per_run'
                ? 'New workspace each run'
                : (selectedWorktree?.displayName ?? 'Missing workspace')
            }
            worktreeMap={worktreeMap}
            now={relativeNow}
            onRunNow={(automation) => void runNow(automation)}
            onOpenRunWorkspace={openRunWorkspace}
            onEdit={(automation) => void openEditDialog(automation)}
            onToggle={(automation) => void toggleAutomation(automation)}
            onDelete={requestDeleteAutomation}
          />
          <ExternalAutomationManagers
            managers={externalManagers}
            now={relativeNow}
            runningActionKey={externalActionKey}
            onAction={requestExternalAction}
          />
        </section>
      </div>
    </main>
  )
}
