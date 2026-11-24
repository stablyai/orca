import { useCallback, useRef, useState } from 'react'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import { useAppStore } from '@/store/index'
import { useActiveRepo } from '@/store/repos/use-repository-catalog'
import {
  evaluateCompletionGate,
  type HarnessPolicy
} from '../../../../shared/harness/harness-policy'
import { executeWorkflowNode } from './workflow-node-executor'
import type { AutomationStageState } from './workbench-automation-bar'
import type { WorkflowNodeDef, WorkflowPreset } from './workflow-presets'

export type NodeRunLog = {
  nodeId: string
  kind: WorkflowNodeDef['kind']
  label: string
  status: AutomationStageState['status']
  meta?: string
  startedAt?: number
  finishedAt?: number
  output?: string
  error?: string
}

export type WorkflowRunRecord = {
  id: string
  presetId: string
  requirement: string
  startedAt: number
  finishedAt?: number
  worktreeId?: string
  worktreePath?: string
  branch?: string
  nodes: NodeRunLog[]
  finished: boolean
  running: boolean
  error?: string
}

function buildWorktreeSlug(requirement: string): string {
  const slug = requirement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
  return slug ? `wf-${slug}` : `wf-${Date.now()}`
}

export function useWorkflowRunner(
  getNodeLabel: (node: WorkflowNodeDef) => string,
  getNodeDesc: (node: WorkflowNodeDef) => string,
  harnessPolicy?: HarnessPolicy,
  targetOverride?: {
    repo: ReturnType<typeof useActiveRepo>
    dirPath: string | null
  }
) {
  const activeRepo = useActiveRepo()
  const repo = targetOverride ? targetOverride.repo : activeRepo
  const fallbackDir = targetOverride?.dirPath ?? repo?.path
  const [activeRun, setActiveRun] = useState<WorkflowRunRecord | null>(null)
  const cancelRef = useRef(false)

  const patchNode = useCallback((nodeId: string, patch: Partial<NodeRunLog>) => {
    setActiveRun((prev) =>
      prev
        ? { ...prev, nodes: prev.nodes.map((n) => (n.nodeId === nodeId ? { ...n, ...patch } : n)) }
        : null
    )
  }, [])

  const runFromIndex = useCallback(
    async (
      preset: WorkflowPreset,
      reqText: string,
      startIndex: number,
      existingWorktree?: { id: string; path: string; branch?: string }
    ) => {
      cancelRef.current = false
      let wt = existingWorktree

      if (!wt && repo) {
        try {
          const created = await useAppStore
            .getState()
            .createWorktree(
              repo.id,
              buildWorktreeSlug(reqText),
              undefined,
              undefined,
              undefined,
              undefined,
              reqText.slice(0, 80),
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
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                executionHostId: getRepoExecutionHostId(repo),
                startupDraft: reqText,
                note: reqText
              }
            )
          wt = {
            id: created.worktree.id,
            path: created.worktree.path,
            branch: created.worktree.git?.branch
          }
          setActiveRun((prev) =>
            prev
              ? { ...prev, worktreeId: wt?.id, worktreePath: wt?.path, branch: wt?.branch }
              : null
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          setActiveRun((prev) =>
            prev ? { ...prev, running: false, finishedAt: Date.now(), error: msg } : null
          )
          return
        }
      }

      for (let i = startIndex; i < preset.nodes.length; i += 1) {
        if (cancelRef.current) {
          setActiveRun((prev) =>
            prev ? { ...prev, running: false, finishedAt: Date.now() } : null
          )
          return
        }
        const node = preset.nodes[i]
        patchNode(node.id, {
          status: 'active',
          startedAt: Date.now(),
          finishedAt: undefined,
          error: undefined
        })
        try {
          const result = await executeWorkflowNode({
            node,
            worktreePath: wt?.path ?? fallbackDir ?? undefined,
            reqText,
            repo,
            harnessPolicy,
            getNodeDesc
          })
          const finishedAt = Date.now()
          if (!result.ok) {
            patchNode(node.id, {
              status: 'attention',
              finishedAt,
              output: result.output,
              error: result.output
            })
            setActiveRun((prev) =>
              prev ? { ...prev, running: false, finishedAt, error: result.output } : null
            )
            return
          }
          patchNode(node.id, {
            status: 'pass',
            finishedAt,
            output: result.output,
            error: undefined
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const finishedAt = Date.now()
          patchNode(node.id, { status: 'attention', finishedAt, error: msg })
          setActiveRun((prev) =>
            prev ? { ...prev, running: false, finishedAt, error: msg } : null
          )
          return
        }
      }

      const gateDir = wt?.path ?? fallbackDir
      if (harnessPolicy && gateDir && isTauriNativeHost() && !repo?.connectionId) {
        try {
          const gitStatus = await invokeNative<{ entries: unknown[] }>('poc_git_status', {
            args: { worktreePath: gateDir }
          })
          const completion = evaluateCompletionGate(gitStatus.entries.length > 0, harnessPolicy)
          if (!completion.allowed) {
            setActiveRun((prev) =>
              prev
                ? {
                    ...prev,
                    running: false,
                    finishedAt: Date.now(),
                    error: completion.reason ?? 'Uncommitted changes remain.'
                  }
                : null
            )
            return
          }
        } catch {
          // Ignore status probe error on non-git folders.
        }
      }

      setActiveRun((prev) =>
        prev ? { ...prev, running: false, finished: true, finishedAt: Date.now() } : null
      )
    },
    [fallbackDir, getNodeDesc, harnessPolicy, patchNode, repo]
  )

  const start = useCallback(
    (preset: WorkflowPreset, reqText: string) => {
      const trimmed = reqText.trim()
      if (!trimmed) {
        return
      }
      const now = Date.now()
      const nodes: NodeRunLog[] = preset.nodes.map((n) => ({
        nodeId: n.id,
        kind: n.kind,
        label: getNodeLabel(n),
        status: 'idle',
        meta:
          n.kind === 'cli' || n.kind === 'verify'
            ? n.instruction?.trim()
            : [n.agent, n.model].filter(Boolean).join(' · ') || undefined
      }))
      setActiveRun({
        id: `wf-${now}`,
        presetId: preset.id,
        requirement: trimmed,
        startedAt: now,
        nodes,
        finished: false,
        running: true
      })
      void runFromIndex(preset, trimmed, 0)
    },
    [getNodeLabel, runFromIndex]
  )

  const retryFailed = useCallback(
    (preset: WorkflowPreset) => {
      if (!activeRun) {
        return
      }
      const failedIndex = activeRun.nodes.findIndex((n) => n.status === 'attention')
      const startIdx = Math.max(failedIndex, 0)
      setActiveRun((prev) =>
        prev ? { ...prev, running: true, finishedAt: undefined, error: undefined } : null
      )
      void runFromIndex(
        preset,
        activeRun.requirement,
        startIdx,
        activeRun.worktreeId && activeRun.worktreePath
          ? { id: activeRun.worktreeId, path: activeRun.worktreePath, branch: activeRun.branch }
          : undefined
      )
    },
    [activeRun, runFromIndex]
  )

  const stop = useCallback(() => {
    cancelRef.current = true
  }, [])

  const clearRun = useCallback(() => {
    cancelRef.current = true
    setActiveRun(null)
  }, [])

  return { repo, activeRun, start, retryFailed, stop, clearRun }
}
