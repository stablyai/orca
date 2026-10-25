import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeGitStatusTarget } from '@/lib/worktree-git-status-target'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import type { Worktree } from '../../../../shared/worktree/types'
import type { LastTabAutoDeleteCandidate } from './last-tab-auto-delete-candidate'
import {
  resolveLastTabAutoDeleteTarget,
  type LastTabAutoDeleteTarget
} from './last-tab-auto-delete-eligibility'

const GIT_STATUS_TIMEOUT_MS = 10_000

type QueueEntry = { key: string; candidate: LastTabAutoDeleteCandidate }

const queue: QueueEntry[] = []
/** Queued, running, or holding the dialog its run opened: a duplicate must not prompt again. */
const busyKeys = new Set<string>()
let heldKey: string | null = null
let running = false
let scheduled = false
let stopWaitingForModal: (() => void) | null = null

function identityKey(target: LastTabAutoDeleteTarget): string {
  return target.kind === 'worktree'
    ? `worktree|${target.worktree.id}|${target.worktree.hostId ?? ''}|${target.worktree.instanceId ?? ''}`
    : `folder|${target.folderWorkspaceId}|${target.executionHostId ?? ''}`
}

/** Starts the normal workspace delete for an emptied workspace, one at a time and never over another modal. */
export function enqueueLastTabAutoDelete(candidate: LastTabAutoDeleteCandidate): void {
  const target = resolveLastTabAutoDeleteTarget(useAppStore.getState(), candidate)
  if (!target) {
    return
  }
  const key = identityKey(target)
  if (busyKeys.has(key)) {
    return
  }
  busyKeys.add(key)
  queue.push({ key, candidate })
  scheduleDrive()
}

function scheduleDrive(): void {
  if (scheduled) {
    return
  }
  scheduled = true
  // Why a tick: the close that emptied the workspace is still unwinding its own state writes.
  setTimeout(() => {
    scheduled = false
    drive()
  }, 0)
}

function drive(): void {
  if (running) {
    return
  }
  // Why wait: there is one modal slot and openModal would replace whatever the user is looking at.
  if (useAppStore.getState().activeModal !== 'none') {
    waitForModalToClose()
    return
  }
  if (heldKey) {
    busyKeys.delete(heldKey)
    heldKey = null
  }
  const entry = queue.shift()
  if (!entry) {
    return
  }
  running = true
  void runEntry(entry.candidate)
    .then(
      (outcome) => {
        if (outcome === 'requeue') {
          queue.unshift(entry)
        } else {
          heldKey = entry.key
        }
      },
      () => {
        heldKey = entry.key
      }
    )
    .finally(() => {
      running = false
      drive()
    })
}

function waitForModalToClose(): void {
  if (stopWaitingForModal) {
    return
  }
  stopWaitingForModal = useAppStore.subscribe((state) => {
    if (state.activeModal !== 'none') {
      return
    }
    stopWaitingForModal?.()
    stopWaitingForModal = null
    scheduleDrive()
  })
}

async function runEntry(candidate: LastTabAutoDeleteCandidate): Promise<'done' | 'requeue'> {
  // Why lazy: every tab close imports this queue, and the delete flows' module graph is large.
  const [{ runWorktreeDelete }, { deleteFolderWorkspaceUnlessUnsaved }] = await Promise.all([
    import('@/components/sidebar/delete-worktree-flow'),
    import('@/components/sidebar/folder-workspace-delete')
  ])
  const target = resolveLastTabAutoDeleteTarget(useAppStore.getState(), candidate)
  if (!target) {
    return 'done'
  }
  if (useAppStore.getState().activeModal !== 'none') {
    return 'requeue'
  }
  if (target.kind === 'folder') {
    await deleteFolderWorkspaceUnlessUnsaved(
      useAppStore.getState,
      target.folderWorkspaceId,
      target.executionHostId
    )
    return 'done'
  }
  const worktree = target.worktree
  const options = {
    expectedHostId: worktree.hostId,
    expectedInstanceId: worktree.instanceId,
    unprompted: true,
    // Why: a no-dialog delete can wait on hook confirmation, and the workspace may refill meanwhile.
    assertBeforeDispatch: () => {
      if (!resolveLastTabAutoDeleteTarget(useAppStore.getState(), candidate)) {
        throw new Error(
          translate(
            'auto.lib.last.tab.auto.delete.last.tab.auto.delete.queue.kept',
            'Kept the workspace: it has tabs again or auto-delete was turned off.'
          )
        )
      }
    }
  }
  const skipConfirm = useAppStore.getState().settings?.skipDeleteWorktreeConfirm ?? false
  if (candidate.trigger !== 'exit' || !skipConfirm) {
    await runWorktreeDelete(worktree.id, options)
    return 'done'
  }
  // Why: nobody clicked anything on a process exit, so dirty or unknown changes always get the dialog.
  const clean = await isWorktreeClean(worktree)
  if (!resolveLastTabAutoDeleteTarget(useAppStore.getState(), candidate)) {
    return 'done'
  }
  if (useAppStore.getState().activeModal !== 'none') {
    return 'requeue'
  }
  await runWorktreeDelete(worktree.id, clean ? options : { ...options, forceConfirm: true })
  return 'done'
}

async function isWorktreeClean(worktree: Worktree): Promise<boolean> {
  const statusTarget = resolveWorktreeGitStatusTarget(useAppStore.getState(), worktree)
  if (!statusTarget) {
    return false
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(false)
    }, GIT_STATUS_TIMEOUT_MS)
  })
  const status = getRuntimeGitStatus(
    {
      target: statusTarget.target,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      connectionId: statusTarget.connectionId
    },
    { admissionTier: 'background', includeLineStats: false, signal: controller.signal }
  ).then(
    // Why upstreamStatus: main only sets it when git status itself succeeded; a failed read also has no entries.
    (result) =>
      result.entries.length === 0 && result.upstreamStatus !== undefined && !result.didHitLimit,
    () => false
  )
  try {
    return await Promise.race([status, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export function resetLastTabAutoDeleteQueueForTest(): void {
  queue.length = 0
  busyKeys.clear()
  heldKey = null
  running = false
  scheduled = false
  stopWaitingForModal?.()
  stopWaitingForModal = null
}
