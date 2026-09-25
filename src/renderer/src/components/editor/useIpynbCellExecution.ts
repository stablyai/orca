import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { clearIpynbOutputs, updateIpynbCellRun, withIpynbCellIds } from './ipynb-cell-mutations'
import { toStoredOutputs } from './ipynb-kernel-outputs'
import {
  forgetFinishedRuns,
  markRunCommitted,
  runCells,
  trustNotebook
} from './ipynb-kernel-session'
import {
  getCellRun,
  getSession,
  useUncommittedRunKeys,
  type QueuedCell
} from './ipynb-kernel-store'
import { parseIpynb } from './ipynb-parse'
import { getIpynbCellKey } from './useIpynbDocumentEditing'

type UseIpynbCellExecutionArgs = {
  filePath: string
  worktreeId: string
  /** The workspace root, where the search for a project `.venv` stops. */
  rootPath: string | null
  flushSourceDrafts: () => string
  applyContent: (content: string) => void
}

export function useIpynbCellExecution({
  filePath,
  worktreeId,
  rootPath,
  flushSourceDrafts,
  applyContent
}: UseIpynbCellExecutionArgs) {
  const uncommittedRunKeys = useUncommittedRunKeys(filePath)
  const [pendingRun, setPendingRun] = useState<QueuedCell[] | null>(null)

  // Why: runs can finish while this notebook is not the visible tab, so outputs wait in the kernel
  // session until the open document takes them in.
  useEffect(() => {
    if (uncommittedRunKeys.length === 0) {
      return
    }
    const latestContent = flushSourceDrafts()
    let nextContent = latestContent
    try {
      const cells = parseIpynb(latestContent).cells
      for (const key of uncommittedRunKeys) {
        const run = getCellRun(filePath, key)
        const index = cells.findIndex((cell, cellIndex) => getIpynbCellKey(cell, cellIndex) === key)
        if (run && index !== -1) {
          nextContent = updateIpynbCellRun(
            nextContent,
            index,
            toStoredOutputs(run.outputs),
            run.executionCount
          )
        }
      }
    } catch {
      // An unparseable document has no cells to take outputs; drop them.
    }
    for (const key of uncommittedRunKeys) {
      markRunCommitted(filePath, key)
    }
    if (nextContent !== latestContent) {
      applyContent(nextContent)
    }
  }, [applyContent, filePath, flushSourceDrafts, uncommittedRunKeys])

  const run = (indexes: number[]): void => {
    const drafted = flushSourceDrafts()
    const notebook = parseIpynb(drafted)
    const codeIndexes = indexes.filter((index) => notebook.cells[index]?.kind === 'code')
    if (codeIndexes.length === 0) {
      return
    }
    if (getConnectionId(worktreeId) || notebook.language !== 'python') {
      toast.error(
        getConnectionId(worktreeId)
          ? translate(
              'auto.components.editor.IpynbViewer.localOnly',
              'Notebook cells can only run for files on this computer.'
            )
          : translate(
              'auto.components.editor.IpynbViewer.pythonOnly',
              'Only Python notebooks can run in Orca.'
            )
      )
      return
    }
    // Why: id-less (nbformat 4.4) cells are keyed by index, so a move mid-run would misroute output.
    const content = withIpynbCellIds(drafted)
    if (content !== drafted) {
      applyContent(content)
    }
    const { cells } = parseIpynb(content)
    const queued = codeIndexes.flatMap((index) => {
      const cell = cells[index]
      return cell ? [{ key: getIpynbCellKey(cell, index), code: cell.source }] : []
    })
    if (getSession(filePath).trusted) {
      void runCells(filePath, queued, rootPath)
    } else {
      setPendingRun(queued)
    }
  }

  const confirmPendingRun = (): void => {
    trustNotebook(filePath)
    setPendingRun(null)
    if (pendingRun) {
      void runCells(filePath, pendingRun, rootPath)
    }
  }

  const clearAllOutputs = (): void => {
    applyContent(clearIpynbOutputs(flushSourceDrafts()))
    forgetFinishedRuns(filePath)
  }

  return {
    pendingRun,
    cancelPendingRun: () => setPendingRun(null),
    confirmPendingRun,
    runCell: (index: number) => run([index]),
    runAll: (cellCount: number) => run([...Array(cellCount).keys()]),
    clearAllOutputs
  }
}
