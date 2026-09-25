import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { createStore } from 'zustand/vanilla'
import type { PythonEnvironment } from '../../../../shared/notebook-kernel-types'
import type { LiveOutputs } from './ipynb-kernel-outputs'
import { isRecord } from './ipynb-parse'

export type QueuedCell = { key: string; code: string }

/** A cell's latest run. Outputs live here until the open notebook writes them into its document. */
export type CellRun = LiveOutputs & {
  executionCount: number | null
  startedAt: number
  /** Null while the cell is executing. */
  finishedAt: number | null
  committed: boolean
}

type KernelStatus = 'off' | 'starting' | 'ready' | 'dead'

/** Getting ipykernel into a Python; while set, the setup dialog is open and cells wait. */
export type KernelSetup = {
  /** The interpreter missing ipykernel, or the base of the new `.venv`. */
  base: PythonEnvironment
  /** `venv` when pip refuses to install into `base` (PEP 668), or the user asked for one. */
  offer: 'install' | 'venv'
  phase: 'idle' | 'installing' | 'creating-venv'
  error: string | null
}

export type NotebookKernelSession = {
  trusted: boolean
  status: KernelStatus
  /** Cells waiting for the kernel; the executing cell is the run with no `finishedAt`. */
  queue: QueuedCell[]
  runs: Record<string, CellRun>
  interruptStalled: boolean
  setup: KernelSetup | null
}

const IDLE_SESSION: NotebookKernelSession = {
  trusted: false,
  status: 'off',
  queue: [],
  runs: {},
  interruptStalled: false,
  setup: null
}
const ENVIRONMENTS_STORAGE_KEY = 'orca.notebookPythonEnvironments'

function loadEnvironments(): Record<string, PythonEnvironment> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ENVIRONMENTS_STORAGE_KEY) ?? '{}')
    return isRecord(stored)
      ? Object.fromEntries(
          Object.entries(stored).flatMap(([filePath, env]) =>
            isRecord(env) &&
            typeof env.path === 'string' &&
            typeof env.name === 'string' &&
            typeof env.version === 'string'
              ? [[filePath, { path: env.path, name: env.name, version: env.version }]]
              : []
          )
        )
      : {}
  } catch {
    return {}
  }
}

export const store = createStore<{
  /** The interpreter chosen per notebook, remembered in Orca rather than in the .ipynb. */
  environments: Record<string, PythonEnvironment>
  sessions: Record<string, NotebookKernelSession>
}>(() => ({ environments: loadEnvironments(), sessions: {} }))

export function getSession(filePath: string): NotebookKernelSession {
  return store.getState().sessions[filePath] ?? IDLE_SESSION
}

export function updateSession(
  filePath: string,
  update: (session: NotebookKernelSession) => Partial<NotebookKernelSession>
): void {
  store.setState(({ sessions }) => {
    const session = sessions[filePath] ?? IDLE_SESSION
    return { sessions: { ...sessions, [filePath]: { ...session, ...update(session) } } }
  })
}

/** Kernel-level state; excludes run outputs so streaming output re-renders only its own cell. */
export function useNotebookKernelState(filePath: string) {
  return useStore(
    store,
    useShallow((state) => {
      const session = state.sessions[filePath] ?? IDLE_SESSION
      return {
        environment: state.environments[filePath] ?? null,
        status: session.status,
        trusted: session.trusted,
        busy: session.queue.length > 0 || runningCellKey(session) !== null,
        interruptStalled: session.interruptStalled,
        setup: session.setup
      }
    })
  )
}

export function useCellRun(
  filePath: string,
  key: string
): { run: CellRun | undefined; queued: boolean } {
  return useStore(
    store,
    useShallow((state) => {
      const session = state.sessions[filePath] ?? IDLE_SESSION
      return { run: session.runs[key], queued: session.queue.some((cell) => cell.key === key) }
    })
  )
}

/** Finished runs whose outputs are not yet in the notebook document. */
export function useUncommittedRunKeys(filePath: string): string[] {
  return useStore(
    store,
    useShallow((state) =>
      Object.entries(state.sessions[filePath]?.runs ?? {})
        .filter(([, run]) => run.finishedAt !== null && !run.committed)
        .map(([key]) => key)
    )
  )
}

export function getCellRun(filePath: string, key: string): CellRun | undefined {
  return getSession(filePath).runs[key]
}

export function runningCellKey(session: NotebookKernelSession): string | null {
  return Object.entries(session.runs).find(([, run]) => run.finishedAt === null)?.[0] ?? null
}

export function setEnvironment(filePath: string, environment: PythonEnvironment): void {
  store.setState(({ environments }) => ({
    environments: { ...environments, [filePath]: environment }
  }))
  try {
    localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify(store.getState().environments))
  } catch {
    // Storage full or unavailable: the choice still holds for this session.
  }
}
