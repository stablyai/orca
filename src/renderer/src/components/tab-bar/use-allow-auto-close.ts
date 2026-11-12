import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import '../terminal-pane/layout/terminal-layout-leaf-traversal'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import {
  readWorkerAutoClose,
  setWorkerKeptOpen,
  type WorkerAutoCloseSubject
} from '@/runtime/agent-orchestration/worker-auto-close'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

function tabWorkerSubjects(tabId: string, sessionId: string | undefined): WorkerAutoCloseSubject[] {
  if (sessionId) {
    return [{ sessionId }]
  }
  const leafIds = collectLayoutLeafIdsInOrder(
    useAppStore.getState().terminalLayoutsByTabId[tabId]?.root
  )
  return leafIds.filter(isTerminalLeafId).map((leafId) => ({ paneKey: makePaneKey(tabId, leafId) }))
}

/** While the tab menu is open: undo for a worker the user kept open, else undefined. */
export function useAllowAutoClose(args: {
  open: boolean
  tabId: string
  worktreeId: string
  sessionId: string | undefined
}): (() => void) | undefined {
  const { open, tabId, worktreeId, sessionId } = args
  const [kept, setKept] = useState<{
    target: RuntimeClientTarget
    subjects: WorkerAutoCloseSubject[]
  } | null>(null)
  useEffect(() => {
    setKept(null)
    if (!open) {
      return
    }
    const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
    const target: RuntimeClientTarget =
      environmentId !== null ? { kind: 'environment', environmentId } : { kind: 'local' }
    const subjects = tabWorkerSubjects(tabId, sessionId)
    let cancelled = false
    void Promise.all(subjects.map((subject) => readWorkerAutoClose(target, subject))).then(
      (states) => {
        const keptSubjects = subjects.filter((_, index) => states[index]?.kept === true)
        if (!cancelled && keptSubjects.length > 0) {
          setKept({ target, subjects: keptSubjects })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, tabId, worktreeId, sessionId])
  const allow = useCallback(() => {
    if (!kept) {
      return
    }
    for (const subject of kept.subjects) {
      void setWorkerKeptOpen(kept.target, subject, false).catch(() => {})
    }
  }, [kept])
  return kept ? allow : undefined
}
