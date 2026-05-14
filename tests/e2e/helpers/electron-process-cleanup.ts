import type { ChildProcess } from 'child_process'
import { execFileSync } from 'child_process'
import type { ElectronApplication } from '@stablyai/playwright-test'

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      proc.off('exit', onExit)
      proc.off('close', onExit)
      resolve(false)
    }, timeoutMs)

    const onExit = (): void => {
      clearTimeout(timeout)
      resolve(true)
    }

    proc.once('exit', onExit)
    proc.once('close', onExit)
  })
}

function childPidsOf(pid: number): number[] {
  if (process.platform === 'win32') {
    return []
  }

  try {
    const output = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!output) {
      return []
    }
    return output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  } catch {
    return []
  }
}

function collectProcessTree(pid: number): number[] {
  const descendants: number[] = []
  const visit = (parentPid: number): void => {
    for (const childPid of childPidsOf(parentPid)) {
      visit(childPid)
      descendants.push(childPid)
    }
  }

  visit(pid)
  return descendants
}

export async function killProcessTree(proc: ChildProcess | null | undefined): Promise<void> {
  const pid = proc?.pid
  if (!pid) {
    return
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* process already exited */
    }
    await waitForProcessExit(proc, 5_000)
    return
  }

  // Why: CI failures left orphan Electron renderer and shell processes after
  // Playwright reported all tests passed. Kill descendants first so PTY shells
  // cannot keep the Electron process tree alive during worker teardown.
  for (const childPid of collectProcessTree(pid)) {
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {
      /* process already exited */
    }
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* process already exited */
  }

  await waitForProcessExit(proc, 5_000)
}

export async function closeElectronApp(
  app: ElectronApplication,
  options?: { forceOnly?: boolean }
) {
  const appProcess = app.process()

  if (options?.forceOnly) {
    await killProcessTree(appProcess)
    return
  }

  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timed out closing Electron app')), 10_000)
      })
    ])
  } catch {
    await killProcessTree(appProcess)
  }
}
