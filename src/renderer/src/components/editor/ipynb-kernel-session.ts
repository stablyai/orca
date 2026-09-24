import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  KernelFrameEvent,
  KernelStartResult,
  PythonEnvironment
} from '../../../../shared/notebook-kernel-types'
import { applyKernelOutput, type NotebookOutput } from './ipynb-kernel-outputs'
import {
  getSession,
  runningCellKey,
  setEnvironment,
  store,
  updateSession,
  type CellRun,
  type NotebookKernelSession,
  type QueuedCell
} from './ipynb-kernel-store'

const INTERRUPT_STALL_MS = 10_000
/** Install's command as a shell line to copy; Install itself spawns without a shell. */
export function ipykernelInstallCommand(
  python: string,
  windows = navigator.userAgent.includes('Windows')
): string {
  // Why single quotes: literal in POSIX shells and PowerShell; PowerShell runs a quoted path via `&`.
  const program = windows
    ? `& '${python.replaceAll("'", "''")}'`
    : `'${python.replaceAll("'", "'\\''")}'`
  return `${program} -m pip install -U ipykernel`
}

function startRun(): CellRun {
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
function stopRuns(session: NotebookKernelSession, extraOutputs: NotebookOutput[] = []) {
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
function noticeOutput(markdown: string): NotebookOutput {
  return { output_type: 'display_data', data: { 'text/markdown': markdown }, metadata: {} }
}

function fenced(text: string): string {
  return text ? `\n\n\`\`\`\n${text}\n\`\`\`` : ''
}

/** Reports a failure in the first queued cell (a toast when nothing was queued) and drops the queue. */
function failQueue(filePath: string, message: string, detail = ''): void {
  const [head] = getSession(filePath).queue
  if (!head) {
    toast.error(message, { description: detail.slice(-500) })
  }
  updateSession(filePath, ({ runs }) => ({
    status: 'off',
    queue: [],
    runs: head
      ? {
          ...runs,
          [head.key]: {
            ...startRun(),
            outputs: [noticeOutput(message + fenced(detail))],
            finishedAt: Date.now()
          }
        }
      : runs
  }))
}

function pump(filePath: string): void {
  const session = getSession(filePath)
  const [next, ...queue] = session.queue
  if (session.status !== 'ready' || !next || runningCellKey(session) !== null) {
    return
  }
  updateSession(filePath, ({ runs }) => ({ queue, runs: { ...runs, [next.key]: startRun() } }))
  void window.api.notebook.execute({ filePath, code: next.code })
}

/** False once the notebook's tab has closed, which ends its session mid-await. */
function isOpen(filePath: string): boolean {
  return filePath in store.getState().sessions
}

/** Picks the nearest Python for a notebook that has none: a workspace env, else one on PATH. */
async function discoverEnvironment(
  filePath: string,
  rootPath: string | null
): Promise<PythonEnvironment | undefined> {
  const found = await window.api.notebook.listPythonEnvironments({ filePath, rootPath })
  const recommended = found.workspace[0] ?? found.path[0]
  if (recommended && isOpen(filePath)) {
    setEnvironment(filePath, recommended)
  }
  return recommended
}

async function start(filePath: string, rootPath: string | null = null): Promise<void> {
  // Why 'starting' before discovery: a second run meanwhile must queue, not start another kernel.
  updateSession(filePath, () => ({ status: 'starting' }))
  let result: KernelStartResult | null
  try {
    const environment =
      store.getState().environments[filePath] ?? (await discoverEnvironment(filePath, rootPath))
    result =
      environment && isOpen(filePath)
        ? await window.api.notebook.startKernel({ filePath, python: environment.path })
        : null
  } catch (error) {
    result = { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!isOpen(filePath)) {
    return
  }
  if (!result) {
    failQueue(
      filePath,
      translate(
        'auto.components.editor.IpynbViewer.noPython',
        'Python was not found on this computer. Install it from [python.org](https://www.python.org/downloads/), then run the cell again.'
      )
    )
    return
  }
  if (result.status === 'ready') {
    updateSession(filePath, () => ({ status: 'ready' }))
    pump(filePath)
  } else if (result.status === 'missing-ipykernel') {
    updateSession(filePath, () => ({ status: 'missing-ipykernel' }))
  } else {
    failQueue(
      filePath,
      translate(
        'auto.components.editor.IpynbViewer.kernelStartFailed',
        'The kernel failed to start.'
      ),
      result.detail
    )
  }
}

export function trustNotebook(filePath: string): void {
  updateSession(filePath, () => ({ trusted: true }))
}

/** Queues cells to run, starting a kernel in the nearest Python when there is none. */
export async function runCells(
  filePath: string,
  cells: QueuedCell[],
  rootPath: string | null
): Promise<void> {
  updateSession(filePath, (session) => {
    const running = runningCellKey(session)
    const fresh = cells.filter(
      (cell) => cell.key !== running && !session.queue.some((queued) => queued.key === cell.key)
    )
    return { queue: [...session.queue, ...fresh] }
  })
  const { status } = getSession(filePath)
  if (status === 'ready') {
    pump(filePath)
    return
  }
  if (status !== 'off' && status !== 'dead') {
    return
  }
  await start(filePath, rootPath)
}

export function restartKernel(filePath: string): void {
  updateSession(filePath, stopRuns)
  void start(filePath)
}

/** Switching interpreters restarts a running kernel; otherwise queued cells wait for the new one. */
export function selectEnvironment(filePath: string, environment: PythonEnvironment): void {
  setEnvironment(filePath, environment)
  const { status } = getSession(filePath)
  if (status === 'off' || status === 'missing-ipykernel') {
    void start(filePath)
  } else {
    restartKernel(filePath)
  }
}

export function interruptKernel(filePath: string): void {
  const key = runningCellKey(getSession(filePath))
  void window.api.notebook.interrupt({ filePath })
  setTimeout(() => {
    if (key !== null && runningCellKey(getSession(filePath)) === key) {
      updateSession(filePath, () => ({ interruptStalled: true }))
    }
  }, INTERRUPT_STALL_MS)
}

export async function installIpykernel(filePath: string): Promise<void> {
  const environment = store.getState().environments[filePath]
  if (!environment) {
    return
  }
  updateSession(filePath, () => ({ status: 'installing' }))
  const result = await window.api.notebook.installIpykernel({ python: environment.path })
  if (!isOpen(filePath)) {
    return
  }
  if (result.ok) {
    await start(filePath)
    return
  }
  failQueue(
    filePath,
    translate(
      'auto.components.editor.IpynbViewer.installFailed',
      'Installing ipykernel failed. Run `{{command}}` yourself, or create a virtual environment for this project with `{{venvCommand}}` and choose it as the kernel.',
      {
        command: ipykernelInstallCommand(environment.path),
        // Windows installs the `py` launcher; `python3` there is often the Store stub.
        venvCommand: `${navigator.userAgent.includes('Windows') ? 'py' : 'python3'} -m venv .venv`
      }
    ),
    result.detail
  )
}

/** Drops the cells waiting on ipykernel when the user backs out of installing it. */
export function cancelPendingStart(filePath: string): void {
  if (getSession(filePath).status === 'missing-ipykernel') {
    updateSession(filePath, () => ({ status: 'off', queue: [] }))
  }
}

export function markRunCommitted(filePath: string, key: string): void {
  updateSession(filePath, ({ runs }) => {
    const run = runs[key]
    return run ? { runs: { ...runs, [key]: { ...run, outputs: [], committed: true } } } : {}
  })
}

/** Forgets finished runs, e.g. after Clear All Outputs; the executing run keeps streaming. */
export function forgetFinishedRuns(filePath: string): void {
  updateSession(filePath, ({ runs }) => ({
    runs: Object.fromEntries(Object.entries(runs).filter(([, run]) => run.finishedAt === null))
  }))
}

function handleFrame({ filePath, frame }: KernelFrameEvent): void {
  if (!isOpen(filePath)) {
    return
  }
  const session = getSession(filePath)
  if (frame.type === 'exit') {
    const died = translate('auto.components.editor.IpynbViewer.kernelDied', 'The kernel died.')
    updateSession(filePath, (current) => ({
      ...stopRuns(current, [noticeOutput(died + fenced(frame.detail))]),
      status: 'dead'
    }))
    return
  }
  const key = runningCellKey(session)
  if (key === null) {
    return
  }
  if (frame.type === 'done') {
    updateSession(filePath, ({ queue, runs }) => ({
      // Like Jupyter, an error (including an interrupt) cancels the cells queued after it.
      queue: frame.status === 'ok' ? queue : [],
      interruptStalled: false,
      runs: {
        ...runs,
        [key]: { ...runs[key], executionCount: frame.execution_count, finishedAt: Date.now() }
      }
    }))
    pump(filePath)
    return
  }
  updateSession(filePath, ({ runs }) => ({
    runs: { ...runs, [key]: applyKernelOutput(runs[key], frame.type, frame.content) }
  }))
}

// Kernels only exist once this module has loaded with the notebook viewer, so it subscribes here.
window.api.notebook.onKernelFrame(handleFrame)
// A kernel shuts down once its notebook's tab closes, however it closed.
useAppStore.subscribe((state, previous) => {
  if (state.openFiles === previous.openFiles) {
    return
  }
  for (const filePath of Object.keys(store.getState().sessions)) {
    if (!state.openFiles.some((file) => file.filePath === filePath)) {
      void window.api.notebook.shutdownKernel({ filePath })
      store.setState(({ sessions }) => {
        const { [filePath]: _closed, ...rest } = sessions
        return { sessions: rest }
      })
    }
  }
})
