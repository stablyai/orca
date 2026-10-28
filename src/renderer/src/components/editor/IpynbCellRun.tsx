import { memo, useMemo } from 'react'
import { formatToolDuration } from '../../../../shared/native-chat/tools/native-chat-tool-identity'
import { IpynbCellOutputs } from './IpynbCellOutputs'
import { IpynbRunPrompt } from './IpynbCellToolbar'
import { useCellRun } from './ipynb-kernel-store'
import { parseIpynbOutput, type IpynbCell, type IpynbOutput } from './ipynb-parse'

type CellRunProps = { filePath: string; cellKey: string }

export function IpynbCellRunPrompt({
  filePath,
  cellKey,
  executionCount,
  onRun
}: CellRunProps & { executionCount: number | null; onRun: () => void }): React.JSX.Element {
  const { run, queued } = useCellRun(filePath, cellKey)
  return (
    <IpynbRunPrompt
      executionCount={run && !run.committed ? run.executionCount : executionCount}
      state={run?.finishedAt === null ? 'running' : queued ? 'queued' : 'idle'}
      // Only a kernel execution has a duration worth showing, not an Orca notice.
      duration={
        run?.finishedAt && run.executionCount !== null
          ? formatToolDuration(run.finishedAt - run.startedAt)
          : null
      }
      onRun={onRun}
    />
  )
}

/** A cell's outputs: live from its run until the document takes them in, then from the document. */
// Why: every keystroke re-renders the viewer, and re-parsing each cell's saved outputs costs ms.
export const IpynbCellRunOutputs = memo(function IpynbCellRunOutputs({
  filePath,
  cellKey,
  cell
}: CellRunProps & { cell: IpynbCell }): React.JSX.Element | null {
  const { run } = useCellRun(filePath, cellKey)
  const live = useMemo(
    () =>
      run && !run.committed
        ? {
            ...cell,
            executionCount: run.executionCount,
            outputs: run.outputs
              .map(parseIpynbOutput)
              .filter((output): output is IpynbOutput => output !== null)
          }
        : null,
    [cell, run]
  )
  return <IpynbCellOutputs cell={live ?? cell} />
})
