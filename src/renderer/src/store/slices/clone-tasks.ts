import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { upsertAddedRepoWithProjectHostSetup } from '@/components/sidebar/add-repo-store-upsert'
import { translate } from '@/i18n/i18n'

// Why: 10 min mirrors the SSH/runtime clone RPC timeout in useAddRepoCloneFlow.
const CLONE_RPC_TIMEOUT_MS = 10 * 60_000

/** Where a clone runs: the local machine, an SSH host, or a runtime environment. */
export type CloneTaskBackend = 'local' | 'ssh' | 'environment'

/** A background clone the sidebar tracks independently of the add-repo dialog. */
export type CloneTask = {
  id: string
  url: string
  /** Parent folder the repo is cloned into; also the abort/progress match key. */
  destination: string
  displayName: string
  backend: CloneTaskBackend
  /** SSH connection id (backend === 'ssh'). */
  connectionId?: string
  /** Runtime environment id (backend === 'environment'). */
  environmentId?: string
  phase?: string
  percent?: number
  status: 'cloning' | 'success' | 'error'
  error?: string
  /** Set on success so the dialog (if still open) can navigate to the new repo. */
  repoId?: string
  /** True once the Add-Repo dialog closed with this clone still running; only
   *  backgrounded tasks render a sidebar row (avoids duplicating the dialog view). */
  backgrounded: boolean
  startedAt: number
}

/** Inputs the add-repo flow passes to start a background clone. */
export type StartCloneTaskArgs = {
  url: string
  destination: string
  backend: CloneTaskBackend
  connectionId?: string
  environmentId?: string
}

/** Store slice owning background clone tasks: start, progress, cancel, background, dismiss. */
export type CloneTaskSlice = {
  cloneTasksById: Record<string, CloneTask>
  /** Starts a background clone and returns its task id immediately. */
  startCloneTask: (args: StartCloneTaskArgs) => string
  updateCloneTaskProgress: (
    match:
      | { taskId: string }
      | { backend: CloneTaskBackend; destination: string; environmentId?: string }
      | { localOrSsh: true },
    progress: { phase: string; percent: number }
  ) => void
  cancelCloneTask: (taskId: string) => void
  /** Marks a task as backgrounded so the sidebar surfaces it (dialog handoff). */
  backgroundCloneTask: (taskId: string) => void
  dismissCloneTask: (taskId: string) => void
}

// Why: git derives the repo folder from the URL's last path segment; mirror that
// so the sidebar row and success toast name the repo before it exists on disk.
function deriveCloneDisplayName(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[/\\]+$/, '')
  const lastSegment = trimmed.split(/[/\\]/).pop() ?? ''
  const scpLike = lastSegment.includes(':') ? (lastSegment.split(':').pop() ?? '') : lastSegment
  return scpLike || trimmed || url.trim()
}

let cloneTaskSeq = 0

/** Creates the clone-task slice: runs each clone on the host backend, streams
 *  progress, and hands the finished repo off to the project store. */
export const createCloneTaskSlice: StateCreator<AppState, [], [], CloneTaskSlice> = (set, get) => ({
  cloneTasksById: {},

  startCloneTask: (args) => {
    const id = `clone-${++cloneTaskSeq}-${Date.now()}`
    const task: CloneTask = {
      id,
      url: args.url.trim(),
      destination: args.destination.trim(),
      displayName: deriveCloneDisplayName(args.url),
      backend: args.backend,
      connectionId: args.connectionId,
      environmentId: args.environmentId,
      status: 'cloning',
      backgrounded: false,
      startedAt: Date.now()
    }
    set((s) => ({ cloneTasksById: { ...s.cloneTasksById, [id]: task } }))
    void runCloneTask(task, get, set)
    return id
  },

  updateCloneTaskProgress: (match, progress) => {
    set((s) => {
      const entry =
        'taskId' in match
          ? s.cloneTasksById[match.taskId]
          : 'localOrSsh' in match
            ? findActiveLocalOrSshCloneTask(s.cloneTasksById)
            : findActiveCloneTask(
                s.cloneTasksById,
                match.backend,
                match.destination,
                match.environmentId
              )
      if (!entry || entry.status !== 'cloning') {
        return {}
      }
      if (entry.phase === progress.phase && entry.percent === progress.percent) {
        return {}
      }
      return {
        cloneTasksById: {
          ...s.cloneTasksById,
          [entry.id]: { ...entry, phase: progress.phase, percent: progress.percent }
        }
      }
    })
  },

  cancelCloneTask: (taskId) => {
    const task = get().cloneTasksById[taskId]
    if (task && task.status === 'cloning') {
      void abortCloneBackend(task)
    }
    removeCloneTask(set, taskId)
  },

  backgroundCloneTask: (taskId) => {
    const entry = get().cloneTasksById[taskId]
    if (!entry || entry.backgrounded || entry.status === 'error') {
      // Why: a failed clone stays dialog-owned until dismissed; nothing to hand off.
      return
    }
    // Why: a clone that finished before backgrounding was skipped by notify/navigation, so hand off the toast here.
    const alreadyFinished = entry.status === 'success'
    set((s) => {
      const current = s.cloneTasksById[taskId]
      if (!current || current.backgrounded) {
        return {}
      }
      return {
        cloneTasksById: { ...s.cloneTasksById, [taskId]: { ...current, backgrounded: true } }
      }
    })
    if (alreadyFinished) {
      const backgrounded = get().cloneTasksById[taskId]
      if (backgrounded?.status === 'success' && backgrounded.repoId) {
        notifyCloneComplete(backgrounded.displayName)
      }
    }
  },

  dismissCloneTask: (taskId) => {
    removeCloneTask(set, taskId)
  }
})

function removeCloneTask(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  taskId: string
): void {
  set((s) => {
    if (!s.cloneTasksById[taskId]) {
      return {}
    }
    const { [taskId]: _removed, ...rest } = s.cloneTasksById
    return { cloneTasksById: rest }
  })
}

// Why: env clones aren't serialized, so a shared destination needs environmentId to disambiguate.
function findActiveCloneTask(
  tasksById: Record<string, CloneTask>,
  backend: CloneTaskBackend,
  destination: string,
  environmentId?: string
): CloneTask | undefined {
  const trimmed = destination.trim()
  return Object.values(tasksById).find(
    (task) =>
      task.status === 'cloning' &&
      task.backend === backend &&
      task.destination === trimmed &&
      (environmentId === undefined || task.environmentId === environmentId)
  )
}

// Why: the `repos:clone-progress` IPC payload carries no destination, and the
// main process serializes local/ssh clones through a single active-clone handle,
// so the one in-flight local-or-ssh task is the unambiguous target.
function findActiveLocalOrSshCloneTask(
  tasksById: Record<string, CloneTask>
): CloneTask | undefined {
  return Object.values(tasksById).find(
    (task) => task.status === 'cloning' && task.backend !== 'environment'
  )
}

async function runCloneTask(
  task: CloneTask,
  get: () => AppState,
  set: (fn: (s: AppState) => Partial<AppState>) => void
): Promise<void> {
  try {
    const repo = await cloneWithBackend(task)
    // Why: the user may have dismissed the row (canceling the intent) while the
    // clone finished; don't resurrect a task the user let go of.
    if (!get().cloneTasksById[task.id]) {
      return
    }
    upsertAddedRepoWithProjectHostSetup(repo)
    await get().fetchWorktrees(repo.id, { requireAuthoritative: true })
    if (!get().cloneTasksById[task.id]) {
      return
    }
    set((s) => {
      const entry = s.cloneTasksById[task.id]
      if (!entry) {
        return {}
      }
      return {
        cloneTasksById: {
          ...s.cloneTasksById,
          // Why: sync displayName to the real repo name so the deferred
          // backgroundCloneTask notify path reads the same confirmed label.
          [task.id]: {
            ...entry,
            status: 'success',
            percent: 100,
            repoId: repo.id,
            displayName: repo.displayName
          }
        }
      }
    })
    // Why: only the backgrounded case needs the tray/native ping — a clone
    // finishing while its dialog is open already navigates and toasts inline.
    const finished = get().cloneTasksById[task.id]
    if (finished?.backgrounded) {
      notifyCloneComplete(finished.displayName)
    }
  } catch (err) {
    if (!get().cloneTasksById[task.id]) {
      return
    }
    const message = extractIpcErrorMessage(err, String(err))
    set((s) => {
      const entry = s.cloneTasksById[task.id]
      if (!entry) {
        return {}
      }
      return {
        cloneTasksById: {
          ...s.cloneTasksById,
          [task.id]: { ...entry, status: 'error', error: message }
        }
      }
    })
  }
}

async function cloneWithBackend(task: CloneTask): Promise<Repo> {
  if (task.backend === 'ssh') {
    return (await window.api.repos.cloneRemote({
      connectionId: requireCloneTaskField(task, 'connectionId'),
      url: task.url,
      destination: task.destination
    })) as Repo
  }
  if (task.backend === 'environment') {
    const target: RuntimeClientTarget = {
      kind: 'environment',
      environmentId: requireCloneTaskField(task, 'environmentId')
    }
    const result = await callRuntimeRpc<{ repo: Repo }>(
      target,
      'repo.clone',
      { url: task.url, destination: task.destination },
      { timeoutMs: CLONE_RPC_TIMEOUT_MS }
    )
    return result.repo
  }
  return (await window.api.repos.clone({ url: task.url, destination: task.destination })) as Repo
}

async function abortCloneBackend(task: CloneTask): Promise<void> {
  try {
    if (task.backend === 'environment') {
      const target: RuntimeClientTarget = {
        kind: 'environment',
        environmentId: requireCloneTaskField(task, 'environmentId')
      }
      await callRuntimeRpc(target, 'repo.cloneAbort', { destination: task.destination })
      return
    }
    // Local and SSH share the single active-clone abort handle in the main process.
    await window.api.repos.cloneAbort()
  } catch {
    // Best effort: canceling the row shouldn't block on a finished/unreachable clone.
  }
}

// Why: connectionId/environmentId are optional on CloneTask but required for
// their backend. Surface a clear invariant violation instead of forwarding
// `undefined` through a silent `as string` cast into an opaque IPC/RPC error.
function requireCloneTaskField(task: CloneTask, field: 'connectionId' | 'environmentId'): string {
  const value = task[field]
  if (!value) {
    throw new Error(`Clone task ${task.id} (${task.backend}) is missing ${field}`)
  }
  return value
}

function notifyCloneComplete(repoLabel: string): void {
  toast.success(translate('auto.store.slices.cloneTasks.cloneSucceeded', 'Repository cloned'), {
    description: repoLabel
  })
  // Why: main process gates on window visibility and lights the tray dot; a
  // backgrounded clone that finishes while Orca is hidden still reaches the user.
  void window.api.notifications
    .dispatch({
      source: 'clone-complete',
      repoLabel,
      worktreeLabel: repoLabel
    })
    .catch(() => {
      // Best effort: an unsupported/disabled notification path must not break the clone.
    })
}
