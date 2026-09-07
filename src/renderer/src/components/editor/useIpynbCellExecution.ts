import { useLayoutEffect, useRef, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { updateIpynbCellOutputs } from './ipynb-cell-mutations'
import { parseIpynb } from './ipynb-parse'

type FileExecutionTrust = {
  filePath: string
  revision: number
  trusted: boolean
}

type PendingCellRun = {
  fileRevision: number
  cellIndex: number
}

type UseIpynbCellExecutionArgs = {
  filePath: string
  worktreeId: string
  flushSourceDrafts: () => string
  applyContent: (content: string) => void
  onSave: (content: string) => Promise<boolean>
}

export function useIpynbCellExecution({
  filePath,
  worktreeId,
  flushSourceDrafts,
  applyContent,
  onSave
}: UseIpynbCellExecutionArgs) {
  const trustRef = useRef<FileExecutionTrust>({ filePath, revision: 0, trusted: false })
  const [pendingRun, setPendingRun] = useState<PendingCellRun | null>(null)
  const [runningCellIndex, setRunningCellIndex] = useState<number | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const fileRevision =
    trustRef.current.filePath === filePath
      ? trustRef.current.revision
      : trustRef.current.revision + 1
  useLayoutEffect(() => {
    if (trustRef.current.filePath !== filePath) {
      trustRef.current = { filePath, revision: fileRevision, trusted: false }
    }
  }, [filePath, fileRevision])
  const pendingRunCellIndex =
    pendingRun?.fileRevision === fileRevision ? pendingRun.cellIndex : null

  const runCell = async (
    index: number,
    options: { skipTrustPrompt?: boolean } = {}
  ): Promise<void> => {
    const latestContent = flushSourceDrafts()
    const latestNotebook = parseIpynb(latestContent)
    const cell = latestNotebook.cells[index]
    if (!cell || cell.kind !== 'code' || runningCellIndex !== null) {
      return
    }
    if (!trustRef.current.trusted && !options.skipTrustPrompt) {
      setPendingRun({ fileRevision, cellIndex: index })
      return
    }
    setRunError(null)
    setRunningCellIndex(index)
    try {
      const didSave = await onSave(latestContent)
      if (!didSave) {
        return
      }
      const result = await window.api.notebook.runPythonCell({
        filePath,
        code: cell.source,
        preamble: latestNotebook.cells
          .slice(0, index)
          .filter((previousCell) => previousCell.kind === 'code')
          .map((previousCell) => previousCell.source)
          .join('\n\n'),
        connectionId: getConnectionId(worktreeId) ?? undefined
      })
      applyContent(updateIpynbCellOutputs(latestContent, index, result))
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunningCellIndex(null)
    }
  }

  const cancelPendingRun = (): void => setPendingRun(null)
  const confirmPendingRun = (): void => {
    const index = pendingRunCellIndex
    trustRef.current.trusted = true
    setPendingRun(null)
    if (index !== null) {
      void runCell(index, { skipTrustPrompt: true })
    }
  }

  return {
    runningCellIndex,
    runError,
    pendingRunCellIndex,
    runCell,
    cancelPendingRun,
    confirmPendingRun
  }
}
