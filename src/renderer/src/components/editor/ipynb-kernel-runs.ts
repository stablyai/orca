import type { NotebookOutput } from './ipynb-kernel-outputs'
import { runningCellKey, type CellRun, type NotebookKernelSession } from './ipynb-kernel-store'

export function startRun(): CellRun {
  return {
    outputs: [],
    clearOnNextOutput: false,
    executionCount: null,
    startedAt: Date.now(),
    finishedAt: null,
    committed: false
  }
}

/** Ends the executing run, if any, and drops every queued cell. */
export function stopRuns(session: NotebookKernelSession, extraOutputs: NotebookOutput[] = []) {
  const key = runningCellKey(session)
  const run = key === null ? null : session.runs[key]
  return {
    queue: [],
    interruptStalled: false,
    runs:
      key === null || !run
        ? session.runs
        : {
            ...session.runs,
            [key]: { ...run, outputs: [...run.outputs, ...extraOutputs], finishedAt: Date.now() }
          }
  }
}

/** Orca's own notices (no Python, install failures) are written as markdown outputs of the cell. */
export function noticeOutput(markdown: string): NotebookOutput {
  return { output_type: 'display_data', data: { 'text/markdown': markdown }, metadata: {} }
}

export function fenced(text: string): string {
  return text ? `\n\n\`\`\`\n${text}\n\`\`\`` : ''
}
