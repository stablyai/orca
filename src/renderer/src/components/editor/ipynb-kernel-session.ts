import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  CreateVenvResult,
  KernelFrameEvent,
  KernelStartResult,
  PythonEnvironment
} from '../../../../shared/notebook-kernel-types'
import { applyKernelOutput } from './ipynb-kernel-outputs'
import { fenced, noticeOutput, startRun, stopRuns } from './ipynb-kernel-runs'
import {
  getSession,
  runningCellKey,
  setEnvironment,
  store,
  updateSession,
  type KernelSetup,
  type QueuedCell
} from './ipynb-kernel-store'

const INTERRUPT_STALL_MS = 10_000

/** Reports a failure in the first queued cell (a toast when nothing was queued) and drops the queue. */
function failQueue(filePath: string, message: string, detail = ''): void {
  const [head] = getSession(filePath).queue
  if (!head) {
    toast.error(message, { description: detail.slice(-500) })
  }
  updateSession(filePath, ({ runs }) => ({
    status: 'off',
    queue: [],
    setup: null,
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
  const found = await window.api.notebook.listPythonEnvironments({
    filePath,
    rootPath,
    runWorkspaceInterpreters: true
  })
  const recommended = found.workspace[0] ?? found.path[0]
  if (recommended && isOpen(filePath)) {
    setEnvironment(filePath, recommended)
  }
  return recommended
}

/** Starts the notebook's kernel; the one place a notebook's Python runs, so it refuses until trusted. */
async function start(filePath: string, rootPath: string | null = null): Promise<void> {
  if (!getSession(filePath).trusted) {
    return
  }
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
    updateSession(filePath, () => ({ status: 'ready', setup: null }))
    pump(filePath)
  } else if (result.status === 'missing-ipykernel') {
    // The kernel was started in this notebook's chosen environment, so it is set.
    const base = store.getState().environments[filePath]
    updateSession(filePath, () => ({
      status: 'off',
      setup: base
        ? { base, offer: result.externallyManaged ? 'venv' : 'install', phase: 'idle', error: null }
        : null
    }))
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
  const { status, setup } = getSession(filePath)
  if (status === 'ready') {
    pump(filePath)
    return
  }
  if (status === 'starting' || setup) {
    return
  }
  await start(filePath, rootPath)
}

export function restartKernel(filePath: string): void {
  updateSession(filePath, stopRuns)
  void start(filePath)
}

/** Switching interpreters restarts a running kernel; before trust it only records the choice. */
export function selectEnvironment(filePath: string, environment: PythonEnvironment): void {
  setEnvironment(filePath, environment)
  // A pick replaces an open setup prompt; the new env reopens it if it lacks ipykernel too.
  updateSession(filePath, ({ setup }) => ({ setup: setup?.phase === 'idle' ? null : setup }))
  if (getSession(filePath).status === 'off') {
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

/** Moves the open setup to `phase`; returns the new setup, or null when there is none. */
function enterSetupPhase(filePath: string, phase: KernelSetup['phase']): KernelSetup | null {
  const current = getSession(filePath).setup
  if (!current) {
    return null
  }
  const setup: KernelSetup = { ...current, phase, error: null }
  updateSession(filePath, () => ({ setup }))
  return setup
}

/** Whether `setup` is still the one on screen; a closed tab or reopened session means no. */
function isShowing(filePath: string, setup: KernelSetup): boolean {
  return getSession(filePath).setup === setup
}

function failSetup(filePath: string, detail: string): void {
  updateSession(filePath, ({ setup }) => ({
    setup: setup && { ...setup, phase: 'idle', error: detail }
  }))
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function installIpykernel(filePath: string): Promise<void> {
  const setup = enterSetupPhase(filePath, 'installing')
  if (!setup) {
    return
  }
  const result = await window.api.notebook
    .installIpykernel({ python: setup.base.path })
    .catch((error: unknown) => ({ ok: false, detail: errorDetail(error) }))
  if (!isShowing(filePath, setup)) {
    return
  }
  if (result.ok) {
    await start(filePath)
  } else {
    failSetup(filePath, result.detail)
  }
}

/** Creates the notebook's `.venv` from the setup's base with ipykernel, then switches to it. */
export async function createVirtualEnvironment(
  filePath: string,
  rootPath: string | null
): Promise<void> {
  const setup = enterSetupPhase(filePath, 'creating-venv')
  if (!setup) {
    return
  }
  const result: CreateVenvResult = await window.api.notebook
    .createVenv({ filePath, rootPath, python: setup.base.path })
    .catch((error: unknown) => ({ ok: false, detail: errorDetail(error) }))
  if (!isShowing(filePath, setup)) {
    return
  }
  if (result.ok) {
    selectEnvironment(filePath, result.environment)
  } else {
    failSetup(filePath, result.detail)
  }
}

/** Opens the setup dialog offering a new `.venv` built from `base`. */
export function offerVirtualEnvironment(filePath: string, base: PythonEnvironment): void {
  updateSession(filePath, () => ({ setup: { base, offer: 'venv', phase: 'idle', error: null } }))
}

/** Closes the setup dialog; cells waiting on a kernel that will not start are dropped. */
export function cancelSetup(filePath: string): void {
  updateSession(filePath, ({ status, queue }) => ({
    setup: null,
    queue: status === 'off' ? [] : queue
  }))
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
