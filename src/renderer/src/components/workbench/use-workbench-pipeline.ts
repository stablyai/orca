import { useCallback, useMemo, useState } from 'react'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { DEFAULT_PIPELINE_CONFIG } from '../../../../shared/github/issue-flow/pipeline-config'
import {
  advancePipelineRun,
  createPipelineRun,
  type PipelineRun
} from '../../../../shared/github/issue-flow/pipeline-run'
import {
  buildPipelineReworkPrompt,
  derivePipelineTaskTriageEvent,
  type PipelineTask
} from '../../../../shared/pipeline/pipeline-task'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store/index'
import { useActiveRepo } from '@/store/repos/use-repository-catalog'
import type { AutomationStageState } from './workbench-automation-bar'

export type WorkbenchBoundWorktree = {
  id: string
  displayName: string
  path: string
  branch?: string
}

export type WorkbenchTaskEntry = {
  task: PipelineTask
  run: PipelineRun
  worktree?: WorkbenchBoundWorktree
  creatingWorktree: boolean
  runningStage?: string
  lastOutput?: string
  reworkPrompt?: string
  error?: string
}

function buildWorktreeName(task: PipelineTask): string {
  if (task.source.kind === 'github_issue') {
    return `issue-${task.source.number}`
  }
  if (task.source.kind === 'linear_ticket') {
    return task.source.identifier.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  }
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug ? `task-${slug}` : `task-${task.createdAt}`
}

export function useWorkbenchPipeline() {
  const repo = useActiveRepo()
  const [entries, setEntries] = useState<readonly WorkbenchTaskEntry[]>([])
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)

  const patchEntry = useCallback(
    (taskId: string, updater: (item: WorkbenchTaskEntry) => WorkbenchTaskEntry) => {
      setEntries((prev) => prev.map((item) => (item.task.id === taskId ? updater(item) : item)))
    },
    []
  )

  const startTask = useCallback(
    async (task: PipelineTask, options?: { requireApproval?: boolean }) => {
      const initialRun = createPipelineRun(DEFAULT_PIPELINE_CONFIG, task)
      const triageEvent = derivePipelineTaskTriageEvent(task, options)
      const triagedRun = advancePipelineRun(DEFAULT_PIPELINE_CONFIG, initialRun, {
        type: triageEvent
      })

      const entry: WorkbenchTaskEntry = {
        task,
        run: triagedRun,
        creatingWorktree: Boolean(repo)
      }

      setEntries((prev) => [entry, ...prev])
      setActiveTaskId(task.id)

      if (!repo) {
        return
      }

      try {
        const created = await useAppStore
          .getState()
          .createWorktree(
            repo.id,
            buildWorktreeName(task),
            undefined,
            undefined,
            undefined,
            undefined,
            task.title,
            task.source.kind === 'github_issue' ? task.source.number : undefined,
            undefined,
            undefined,
            undefined,
            task.source.kind === 'linear_ticket' ? task.source.identifier : undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              executionHostId: getRepoExecutionHostId(repo),
              startupDraft: task.description ?? task.title,
              note: task.description
            }
          )

        patchEntry(task.id, (item) => ({
          ...item,
          creatingWorktree: false,
          worktree: {
            id: created.worktree.id,
            displayName: created.worktree.displayName,
            path: created.worktree.path,
            branch: created.worktree.git?.branch
          }
        }))
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught)
        patchEntry(task.id, (item) => ({ ...item, creatingWorktree: false, error: message }))
      }
    },
    [patchEntry, repo]
  )

  const dispatchEvent = useCallback(
    (taskId: string, eventType: string) => {
      patchEntry(taskId, (item) => ({
        ...item,
        run: advancePipelineRun(DEFAULT_PIPELINE_CONFIG, item.run, { type: eventType })
      }))
    },
    [patchEntry]
  )

  const runStageAction = useCallback(
    async <T>(
      taskId: string,
      stageLabel: string,
      method: string,
      buildParams: (workdir: string) => Record<string, unknown>,
      timeoutMs: number,
      onSuccess: (item: WorkbenchTaskEntry, result: T) => WorkbenchTaskEntry
    ) => {
      const entry = entries.find((item) => item.task.id === taskId)
      if (!entry?.worktree || !repo) {
        return
      }
      const target = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
      if (!target) {
        return
      }
      patchEntry(taskId, (item) => ({ ...item, runningStage: stageLabel, error: undefined }))
      try {
        const result = await callRuntimeRpc<T>(target, method, buildParams(entry.worktree.path), {
          timeoutMs
        })
        patchEntry(taskId, (item) => ({ ...onSuccess(item, result), runningStage: undefined }))
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught)
        patchEntry(taskId, (item) => ({ ...item, runningStage: undefined, error: message }))
      }
    },
    [entries, patchEntry, repo]
  )

  const runCheckGate = useCallback(
    (taskId: string) =>
      runStageAction<{ passed: boolean; output: string }>(
        taskId,
        'check:changed',
        'pipeline.gate.checkChanged',
        (workdir) => ({ workdir }),
        600_000,
        (item, result) => ({
          ...item,
          lastOutput: result.output,
          error: result.passed ? undefined : 'check:changed failed',
          run: result.passed
            ? advancePipelineRun(DEFAULT_PIPELINE_CONFIG, item.run, { type: 'fix:completed' })
            : item.run
        })
      ),
    [runStageAction]
  )

  const runReview = useCallback(
    (taskId: string) =>
      runStageAction<{ verdict: 'pass' | 'needs_changes'; report: string }>(
        taskId,
        'review',
        'pipeline.review.run',
        (workdir) => ({ workdir }),
        300_000,
        (item, result) => {
          const passed = result.verdict === 'pass'
          return {
            ...item,
            lastOutput: result.report,
            reworkPrompt: passed
              ? undefined
              : buildPipelineReworkPrompt({
                  task: item.task,
                  stage: 'review',
                  report: result.report
                }),
            run: advancePipelineRun(DEFAULT_PIPELINE_CONFIG, item.run, {
              type: passed ? 'review:passed' : 'review:changes-requested'
            })
          }
        }
      ),
    [runStageAction]
  )

  const runCiWatch = useCallback(
    (taskId: string, prNumber: number) =>
      runStageAction<{ passed: boolean; output: string }>(
        taskId,
        'ci',
        'pipeline.ci.watch',
        (workdir) => ({ workdir, prNumber }),
        1_800_000,
        (item, result) => ({
          ...item,
          lastOutput: result.output,
          reworkPrompt: result.passed
            ? undefined
            : buildPipelineReworkPrompt({
                task: item.task,
                stage: 'ci',
                report: result.output
              }),
          run: advancePipelineRun(DEFAULT_PIPELINE_CONFIG, item.run, {
            type: result.passed ? 'ci:passed' : 'ci:failed'
          })
        })
      ),
    [runStageAction]
  )

  const runMerge = useCallback(
    (taskId: string, prNumber: number) =>
      runStageAction<{ merged: boolean; blockedByMainCi?: boolean; output: string }>(
        taskId,
        'merge',
        'pipeline.pr.merge',
        (workdir) => ({ workdir, prNumber }),
        60_000,
        (item, result) => ({
          ...item,
          lastOutput: result.output,
          error: result.merged ? undefined : result.output || 'Merge failed',
          run: result.merged
            ? advancePipelineRun(DEFAULT_PIPELINE_CONFIG, item.run, { type: 'merged' })
            : item.run
        })
      ),
    [runStageAction]
  )

  const openWorktree = useCallback((worktreeId: string) => {
    void activateAndRevealWorktree(worktreeId)
  }, [])

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.task.id === activeTaskId) ?? entries[0] ?? null,
    [entries, activeTaskId]
  )

  const stages = useMemo<readonly AutomationStageState[]>(
    () =>
      DEFAULT_PIPELINE_CONFIG.stages.map((stage) => ({
        id: stage.id,
        status: activeEntry ? (activeEntry.run.stages[stage.id] ?? 'idle') : 'idle'
      })),
    [activeEntry]
  )

  return {
    entries,
    activeEntry,
    stages,
    hasRepo: repo !== null && repo !== undefined,
    repoId: repo?.id ?? null,
    startTask,
    selectTask: setActiveTaskId,
    dispatchEvent,
    runCheckGate,
    runReview,
    runCiWatch,
    runMerge,
    openWorktree
  }
}
