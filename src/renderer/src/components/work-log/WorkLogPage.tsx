import React, { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@/store'
import { useRepoById, useWorktreeById } from '@/store/selectors'
import { selectWorktreeAgentActivitySummary } from '@/components/sidebar/worktree-agent-activity-summary'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { WorkLogDailyScheduleCard } from './WorkLogDailyScheduleCard'
import { WorkLogEntryFormCard } from './WorkLogEntryFormCard'
import { WorkLogFocusCard } from './WorkLogFocusCard'
import {
  WorkLogCurrentSurfaceCard,
  WorkLogHeaderCard,
  WorkLogSourceLanesCard,
  WorkLogWeeklySummaryCard
} from './WorkLogSidebarCards'
import {
  badgeDerivedEstimateMinutes,
  buildTimestamp,
  buildWeekWindow,
  createLocalDateKey,
  filterEntriesForDay,
  formatHours,
  summarizeTaskPageData,
  type WorkLogDraft
} from './work-log-page-data'

export default function WorkLogPage(): React.JSX.Element {
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repos = useAppStore((s) => s.repos)
  const workLogEntries = useAppStore((s) => s.workLogEntries)
  const workLogSelectedDate = useAppStore((s) => s.workLogSelectedDate)
  const setWorkLogSelectedDate = useAppStore((s) => s.setWorkLogSelectedDate)
  const addWorkLogEntry = useAppStore((s) => s.addWorkLogEntry)
  const deleteWorkLogEntry = useAppStore((s) => s.deleteWorkLogEntry)
  const taskPageData = useAppStore((s) => s.taskPageData)
  const activeWorktree = useWorktreeById(activeWorktreeId)
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const activeWorktreeSummary = useAppStore(
    useShallow((s) =>
      activeWorktreeId ? selectWorktreeAgentActivitySummary(s, activeWorktreeId) : null
    )
  )

  const selectedDate = workLogSelectedDate ?? createLocalDateKey()
  const [draft, setDraft] = useState<WorkLogDraft>(() => ({
    date: selectedDate,
    startTime: '09:00',
    endTime: '10:00',
    title: '',
    provider: 'activity',
    reference: '',
    notes: '',
    badgeDerived: true
  }))

  const dayEntries = useMemo(
    () => filterEntriesForDay(workLogEntries, selectedDate),
    [selectedDate, workLogEntries]
  )
  const weekWindow = useMemo(() => buildWeekWindow(selectedDate), [selectedDate])
  const weekEntries = useMemo(
    () =>
      workLogEntries.filter((entry) =>
        weekWindow.includes(createLocalDateKey(new Date(entry.startAt)))
      ),
    [weekWindow, workLogEntries]
  )
  const todayMinutes = useMemo(
    () =>
      dayEntries.reduce(
        (total, entry) => total + Math.max(0, Math.round((entry.endAt - entry.startAt) / 60000)),
        0
      ),
    [dayEntries]
  )
  const weekMinutes = useMemo(
    () =>
      weekEntries.reduce(
        (total, entry) => total + Math.max(0, Math.round((entry.endAt - entry.startAt) / 60000)),
        0
      ),
    [weekEntries]
  )
  const focusEstimateMinutes = badgeDerivedEstimateMinutes(activeWorktreeSummary)
  const taskSummary = summarizeTaskPageData(taskPageData)
  const canOpenTasks = repos.some((repo) => isGitRepoKind(repo))
  const taskSurfaceAvailable =
    taskSummary.provider !== null || taskSummary.title !== null || taskPageData.taskSource != null
  const weekDayMinutes = useMemo(
    () =>
      weekWindow.map((dayKey) => {
        const entries = filterEntriesForDay(workLogEntries, dayKey)
        return {
          dayKey,
          minutes: entries.reduce(
            (total, entry) =>
              total + Math.max(0, Math.round((entry.endAt - entry.startAt) / 60000)),
            0
          )
        }
      }),
    [weekWindow, workLogEntries]
  )
  const maxWeekMinutes = Math.max(1, ...weekDayMinutes.map((day) => day.minutes))
  const currentTaskLabel = taskSummary.title ?? taskSummary.label
  const currentTaskMeta = `${taskSummary.provider ?? taskPageData.taskSource ?? 'activity'}${
    taskSummary.reference ? ` · ${taskSummary.reference}` : ''
  }`

  useEffect(() => {
    if (workLogSelectedDate === null) {
      setWorkLogSelectedDate(selectedDate)
    }
  }, [selectedDate, setWorkLogSelectedDate, workLogSelectedDate])

  useEffect(() => {
    setDraft((current) => (current.date === selectedDate ? current : { ...current, date: selectedDate }))
  }, [selectedDate])

  const captureCurrentFocus = (): void => {
    const provider = taskSummary.provider ?? 'activity'
    const title = taskSummary.title ?? activeRepo?.displayName ?? activeWorktreeId ?? 'Current focus block'
    const now = Date.now()
    const durationMinutes = focusEstimateMinutes > 0 ? focusEstimateMinutes : 60
    addWorkLogEntry({
      startAt: now - durationMinutes * 60_000,
      endAt: now,
      title,
      provider,
      reference: taskSummary.reference ?? activeWorktreeId ?? null,
      notes: taskSummary.label,
      badgeDerived: true
    })
  }

  const submitDraft = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const startAt = buildTimestamp(draft.date, draft.startTime)
    const endAt = buildTimestamp(draft.date, draft.endTime)
    if (startAt === null || endAt === null || endAt <= startAt) {
      return
    }
    addWorkLogEntry({
      startAt,
      endAt,
      title: draft.title.trim(),
      provider: draft.provider,
      reference: draft.reference.trim() || null,
      notes: draft.notes.trim() || null,
      badgeDerived: draft.badgeDerived
    })
    setDraft((current) => ({
      ...current,
      title: '',
      reference: '',
      notes: '',
      badgeDerived: true
    }))
    setWorkLogSelectedDate(draft.date)
  }

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-1 flex-col gap-4 px-5 py-4 md:px-8">
        <WorkLogHeaderCard
          selectedDate={selectedDate}
          todayHours={formatHours(todayMinutes)}
          dayEntryCount={dayEntries.length}
        />

        <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.9fr)]">
          <div className="min-h-0 space-y-4">
            <WorkLogFocusCard
              focusEstimateHours={formatHours(focusEstimateMinutes)}
              currentTaskLabel={currentTaskLabel}
              taskSurfaceAvailable={taskSurfaceAvailable}
              taskProviderLabel={taskSummary.provider ?? 'activity'}
              activeWorkspaceLabel={activeRepo?.displayName ?? activeWorktreeId ?? 'None'}
              openTasksDisabled={!canOpenTasks && !taskSurfaceAvailable}
              onCapture={captureCurrentFocus}
              onOpenTasks={() => {
                if (taskSummary.provider !== null || taskSurfaceAvailable) {
                  openTaskPage(taskPageData)
                } else if (canOpenTasks) {
                  openTaskPage()
                }
              }}
              onOpenActivity={openActivityPage}
            />
            <WorkLogDailyScheduleCard
              dayEntries={dayEntries}
              onDelete={deleteWorkLogEntry}
            />
            <WorkLogEntryFormCard
              draft={draft}
              onDraftChange={(updater) => setDraft((current) => updater(current))}
              onSubmit={submitDraft}
            />
          </div>

          <div className="min-h-0 space-y-4">
            <WorkLogSourceLanesCard
              provider={draft.provider}
              onSelect={(provider) => setDraft((current) => ({ ...current, provider }))}
            />
            <WorkLogWeeklySummaryCard
              weekHours={formatHours(weekMinutes)}
              weekEntryCount={weekEntries.length}
              focusHours={formatHours(focusEstimateMinutes)}
              weekDayMinutes={weekDayMinutes}
              maxWeekMinutes={maxWeekMinutes}
            />
            <WorkLogCurrentSurfaceCard
              taskSurfaceAvailable={taskSurfaceAvailable}
              currentTaskLabel={currentTaskLabel}
              currentTaskMeta={currentTaskMeta}
              onReopenTask={() => openTaskPage(taskPageData)}
              onJumpToToday={() => setWorkLogSelectedDate(createLocalDateKey())}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
