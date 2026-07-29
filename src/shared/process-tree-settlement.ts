import { spawn, type ChildProcess } from 'node:child_process'

const POSIX_TREE_KILL_GRACE_MS = 1_000
const POSIX_GROUP_POLL_INTERVAL_MS = 25
// Why: a descendant stuck in uninterruptible I/O (NFS, OneDrive) survives SIGKILL, so an
// unbounded poll would hold the caller's scan permit forever. Give up loudly instead.
const POSIX_GROUP_POLL_LIMIT_MS = 10_000
// Why: taskkill can be missing or denied; without a deadline the caller's promise never settles.
const WINDOWS_TREE_KILL_WAIT_MS = 2_000

/** A live child reports `exitCode === null`; a signal-killed one reports it too, so check both. */
export function hasSubprocessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Kill a spawned command's whole process tree and resolve once the tree is
 * confirmed gone (or the bounded give-up deadline passes).
 */
export function terminateSubprocessTreeAndWait(
  child: ChildProcess,
  leaderAlreadyClosed = false
): Promise<void> {
  const pid = child.pid
  if (!pid) {
    // Why: a spawn that never produced a pid owns no tree, so there is nothing to settle.
    return Promise.resolve()
  }
  if (process.platform === 'win32') {
    return terminateWindowsTreeAndWait(child, pid, leaderAlreadyClosed)
  }
  return terminatePosixTreeAndWait(child, pid, leaderAlreadyClosed)
}

function terminateWindowsTreeAndWait(
  child: ChildProcess,
  pid: number,
  leaderAlreadyClosed: boolean
): Promise<void> {
  return new Promise((resolve) => {
    let childClosed = leaderAlreadyClosed || hasSubprocessExited(child)
    let treeKilled = false
    let settled = false
    let deadline: NodeJS.Timeout | null = null
    const finish = (): void => {
      if (settled || !childClosed || !treeKilled) {
        return
      }
      settled = true
      if (deadline) {
        clearTimeout(deadline)
      }
      resolve()
    }
    const giveUp = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline) {
        clearTimeout(deadline)
      }
      resolve()
    }
    // Why: an absent or denied taskkill must not strand the caller — fall back to a direct
    // kill and let the deadline release the promise even though the tree is unconfirmed.
    const fallbackToChildKill = (): void => {
      if (settled) {
        return
      }
      try {
        child.kill()
      } catch {
        // The child may already have exited between the taskkill failure and now.
      }
      treeKilled = true
      if (!deadline) {
        deadline = setTimeout(giveUp, WINDOWS_TREE_KILL_WAIT_MS)
        deadline.unref()
      }
      finish()
    }
    child.once('close', () => {
      childClosed = true
      finish()
    })
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.once('close', (code) => {
      if (code === 0) {
        treeKilled = true
        finish()
        return
      }
      fallbackToChildKill()
    })
    killer.once('error', fallbackToChildKill)
  })
}

function terminatePosixTreeAndWait(
  child: ChildProcess,
  pid: number,
  leaderAlreadyClosed: boolean
): Promise<void> {
  return new Promise((resolve) => {
    let leaderClosed = leaderAlreadyClosed || hasSubprocessExited(child)
    let groupConfirmedGone = false
    let settled = false
    let forceTimer: NodeJS.Timeout | null = null
    let pollDeadline = 0
    const groupGone = (): boolean => {
      try {
        process.kill(-pid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }
    const confirmGroupGone = (): boolean => {
      groupConfirmedGone ||= groupGone()
      return groupConfirmedGone
    }
    const settle = (): void => {
      settled = true
      if (forceTimer) {
        clearTimeout(forceTimer)
      }
      resolve()
    }
    const finish = (): boolean => {
      if (leaderClosed && groupConfirmedGone) {
        settle()
        return true
      }
      return false
    }
    const poll = (): void => {
      if (settled) {
        return
      }
      if (confirmGroupGone()) {
        finish()
        return
      }
      if (Date.now() >= pollDeadline) {
        console.warn(
          `[process-tree] group ${pid} survived SIGKILL for ${POSIX_GROUP_POLL_LIMIT_MS}ms; releasing it unconfirmed.`
        )
        settle()
        return
      }
      setTimeout(poll, POSIX_GROUP_POLL_INTERVAL_MS).unref()
    }
    child.once('close', () => {
      leaderClosed = true
      confirmGroupGone()
      finish()
    })
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // The group may already be gone; the close/group checks decide settlement.
    }
    forceTimer = setTimeout(() => {
      if (confirmGroupGone()) {
        finish()
        return
      }
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // The group may already be gone.
      }
      pollDeadline = Date.now() + POSIX_GROUP_POLL_LIMIT_MS
      poll()
    }, POSIX_TREE_KILL_GRACE_MS)
    forceTimer.unref()
  })
}

/** After a natural exit, only pay for tree cleanup when descendants outlived the leader. */
export function settleSubprocessTreeAfterExit(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || process.platform === 'win32') {
    return Promise.resolve()
  }
  try {
    process.kill(-pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return Promise.resolve()
    }
  }
  return terminateSubprocessTreeAndWait(child, true)
}
