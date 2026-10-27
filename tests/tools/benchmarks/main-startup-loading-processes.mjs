import { readFileSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'
import {
  descendantsOf,
  readProcessRows
} from '../../../config/scripts/idle-cpu-process-sampling.mjs'

function readIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)
    if (!fields[19]) {
      throw new Error(`Invalid process identity for ${pid}`)
    }
    return { pid, state: fields[0], startTicks: fields[19] }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') {
      return null
    }
    throw error
  }
}

function stillOwned(entry) {
  const current = readIdentity(entry.pid)
  return current?.startTicks === entry.startTicks && current.state !== 'Z'
}

function signalOwned(entries, signal) {
  for (const entry of entries) {
    if (!stillOwned(entry)) {
      continue
    }
    try {
      process.kill(entry.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error
      }
    }
  }
}

async function waitForExit(entries) {
  const deadline = Date.now() + 2_000
  while (entries.some(stillOwned) && Date.now() < deadline) {
    await wait(50)
  }
}

export function createLoadingProcessOwner(childProcess, profile) {
  const rootPid = childProcess.pid
  let root
  let captureError
  try {
    root = readIdentity(rootPid)
  } catch (error) {
    captureError = error
  }
  const owned = new Map(root ? [[rootPid, root]] : [])
  const capture = () => {
    if (!root && childProcess.exitCode === null && childProcess.signalCode === null) {
      root = readIdentity(rootPid)
      if (root) {
        owned.set(rootPid, root)
      }
    }
    const rows = readProcessRows()
    const descendants = new Set(
      root && stillOwned(root) ? descendantsOf(rows, rootPid).map((row) => row.pid) : []
    )
    for (const row of rows) {
      if (!descendants.has(row.pid) && !row.command.includes(profile)) {
        continue
      }
      const entry = readIdentity(row.pid)
      if (entry) {
        owned.set(entry.pid, entry)
      }
    }
  }

  return {
    async close(app) {
      try {
        capture()
      } catch (error) {
        captureError = error
      }
      let timeout
      try {
        await Promise.race([
          app.close().catch(() => {}),
          new Promise((resolve) => {
            timeout = setTimeout(resolve, 10_000)
          })
        ])
      } catch (error) {
        captureError ??= error
      } finally {
        clearTimeout(timeout)
      }
      try {
        capture()
      } catch (error) {
        captureError ??= error
      }
      const entries = [...owned.values()]
      signalOwned(entries, 'SIGTERM')
      await waitForExit(entries)
      signalOwned(entries, 'SIGKILL')
      await waitForExit(entries)
      const survivors = entries.filter(stillOwned)
      if (survivors.length > 0) {
        throw new Error(
          `Benchmark processes survived cleanup: ${survivors.map((entry) => entry.pid).join(', ')}`
        )
      }
      if (captureError) {
        throw captureError
      }
    }
  }
}
