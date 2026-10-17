import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { KernelStartResult, PythonEnvironment } from '../../../../shared/notebook-kernel-types'
import { fenced, noticeOutput, startRun } from './ipynb-kernel-runs'
import {
  getSession,
  runningCellKey,
  setEnvironment,
  store,
  updateSession
} from './ipynb-kernel-store'

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

export function pump(filePath: string): void {
  const session = getSession(filePath)
  const [next, ...queue] = session.queue
  if (session.status !== 'ready' || !next || runningCellKey(session) !== null) {
    return
  }
  updateSession(filePath, ({ runs }) => ({ queue, runs: { ...runs, [next.key]: startRun() } }))
  void window.api.notebook.execute({ filePath, code: next.code })
}

/** Picks the nearest Python for a notebook that has none: a workspace env, else one on PATH. */
async function discoverEnvironment(
  filePath: string,
  rootPath: string | null,
  canStart: () => boolean
): Promise<PythonEnvironment | undefined> {
  const found = await window.api.notebook.listPythonEnvironments({
    filePath,
    rootPath,
    runWorkspaceInterpreters: true
  })
  const recommended = found.workspace[0] ?? found.path[0]
  if (recommended && canStart()) {
    setEnvironment(filePath, recommended)
  }
  return recommended
}

export async function startKernelSession(
  filePath: string,
  rootPath: string | null,
  producerId: string,
  canStart: () => boolean
): Promise<void> {
  let result: KernelStartResult | null
  try {
    const environment =
      store.getState().environments[filePath] ??
      (await discoverEnvironment(filePath, rootPath, canStart))
    result =
      environment && canStart()
        ? await window.api.notebook.startKernel({ filePath, python: environment.path, producerId })
        : null
  } catch (error) {
    result = { status: 'failed', detail: errorDetail(error) }
  }
  if (!canStart()) {
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
