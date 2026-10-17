import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import type {
  CreateVenvResult,
  KernelFrameEvent,
  PythonEnvironment
} from '../../../../shared/notebook-kernel-types'
import { applyKernelOutputs } from './ipynb-kernel-outputs'
import { fenced, noticeOutput, stopRuns } from './ipynb-kernel-runs'
import { errorDetail, pump, startKernelSession } from './ipynb-kernel-start'
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
const RESTART_DEADLINE_MS = 10_000
type SessionLifetime = {
  producerId: string
  pendingRestart?: { timer: ReturnType<typeof setTimeout>; failure: string | null }
}
const sessionLifetimes = new Map<string, SessionLifetime>()

/** False once the notebook's tab has closed, which ends its session mid-await. */
function isOpen(filePath: string): boolean {
  return filePath in store.getState().sessions
}

const isCurrentSession = (filePath: string, lifetime: SessionLifetime): boolean =>
  isOpen(filePath) && sessionLifetimes.get(filePath) === lifetime

/** Starts the notebook's kernel; the one place a notebook's Python runs, so it refuses until trusted. */
async function start(filePath: string, rootPath: string | null = null): Promise<void> {
  if (!getSession(filePath).trusted) {
    return
  }
  const lifetime: SessionLifetime = { producerId: createBrowserUuid() }
  sessionLifetimes.set(filePath, lifetime)
  // Why 'starting' before discovery: a second run meanwhile must queue, not start another kernel.
  updateSession(filePath, () => ({ status: 'starting' }))
  await startKernelSession(
    filePath,
    rootPath,
    lifetime.producerId,
    () => isCurrentSession(filePath, lifetime) && !lifetime.pendingRestart
  )
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
      (cell) =>
        (cell.key !== running || sessionLifetimes.get(filePath)?.pendingRestart) &&
        !session.queue.some((queued) => queued.key === cell.key)
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

function failRestart(filePath: string, lifetime: SessionLifetime): void {
  const pending = lifetime.pendingRestart
  if (!pending || !isCurrentSession(filePath, lifetime)) {
    return
  }
  clearTimeout(pending.timer)
  delete lifetime.pendingRestart
  sessionLifetimes.delete(filePath)
  updateSession(filePath, (current) => ({
    ...stopRuns(current),
    queue: current.queue,
    status: 'off'
  }))
  toast.error(
    translate(
      'auto.components.editor.IpynbViewer.kernelRestartFailed',
      'The kernel could not restart. Run all to try again.'
    ),
    { description: pending.failure?.slice(-500) }
  )
}

export function restartKernel(filePath: string): void {
  const lifetime = sessionLifetimes.get(filePath)
  if (lifetime?.pendingRestart) {
    return
  }
  if (!lifetime) {
    updateSession(filePath, stopRuns)
    void start(filePath)
    return
  }
  lifetime.pendingRestart = {
    timer: setTimeout(() => failRestart(filePath, lifetime), RESTART_DEADLINE_MS),
    failure: null
  }
  updateSession(filePath, () => ({ status: 'starting', queue: [], interruptStalled: false }))
  void window.api.notebook
    .shutdownKernel({ filePath, producerId: lifetime.producerId, drain: true })
    .catch((error: unknown) => {
      if (lifetime.pendingRestart) {
        lifetime.pendingRestart.failure = errorDetail(error)
      }
    })
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

function handleFrame({ filePath, producerId, frame }: KernelFrameEvent): void {
  const lifetime = sessionLifetimes.get(filePath)
  if (!lifetime || !isOpen(filePath) || lifetime.producerId !== producerId) {
    return
  }
  if (frame.type === 'stopped') {
    if (!lifetime.pendingRestart) {
      return
    }
    clearTimeout(lifetime.pendingRestart.timer)
    delete lifetime.pendingRestart
    updateSession(filePath, (current) => ({ ...stopRuns(current), queue: current.queue }))
    sessionLifetimes.delete(filePath)
    void start(filePath)
    return
  }
  const session = getSession(filePath)
  const key = runningCellKey(session)
  if (frame.type === 'exit') {
    const died = translate('auto.components.editor.IpynbViewer.kernelDied', 'The kernel died.')
    if (lifetime.pendingRestart) {
      updateSession(filePath, ({ runs }) => ({
        runs:
          key === null
            ? runs
            : {
                ...runs,
                [key]: {
                  ...runs[key],
                  outputs: [...runs[key].outputs, noticeOutput(died + fenced(frame.detail))]
                }
              }
      }))
      return
    }
    updateSession(filePath, (current) => ({
      ...stopRuns(current, [noticeOutput(died + fenced(frame.detail))]),
      status: 'dead'
    }))
    return
  }
  if (key === null) {
    return
  }
  if (frame.type === 'done') {
    updateSession(filePath, ({ queue, runs }) => ({
      // Like Jupyter, an error (including an interrupt) cancels the cells queued after it.
      queue: frame.status === 'ok' || lifetime.pendingRestart ? queue : [],
      interruptStalled: false,
      runs: {
        ...runs,
        [key]: {
          ...runs[key],
          executionCount: frame.execution_count,
          finishedAt: lifetime.pendingRestart ? null : Date.now()
        }
      }
    }))
    pump(filePath)
    return
  }
  // Why one update per batch: each store update redraws the running cell's outputs.
  updateSession(filePath, ({ runs }) => ({
    runs: { ...runs, [key]: applyKernelOutputs(runs[key], frame.outputs) }
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
      const lifetime = sessionLifetimes.get(filePath)
      if (lifetime?.pendingRestart) {
        clearTimeout(lifetime.pendingRestart.timer)
      }
      sessionLifetimes.delete(filePath)
      void window.api.notebook.shutdownKernel({ filePath })
      store.setState(({ sessions }) => {
        const { [filePath]: _closed, ...rest } = sessions
        return { sessions: rest }
      })
    }
  }
})
