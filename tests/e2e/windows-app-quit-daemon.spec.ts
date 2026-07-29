import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { getDaemonPidPath } from '../../src/main/daemon/daemon-spawner'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId } from './helpers/terminal'

type DaemonIdentity = {
  pid: number
  startedAtMs: number | null
  launchNonce: string | null
}

function readDaemonIdentity(userDataDir: string): {
  identity: DaemonIdentity
  pidPath: string
} {
  const pidPath = getDaemonPidPath(path.join(userDataDir, 'daemon'), PROTOCOL_VERSION)
  const record = JSON.parse(readFileSync(pidPath, 'utf8')) as Partial<DaemonIdentity>
  if (!Number.isInteger(record.pid) || (record.pid ?? 0) <= 0) {
    throw new Error(`Invalid daemon PID record: ${pidPath}`)
  }
  return {
    identity: {
      pid: record.pid!,
      startedAtMs: record.startedAtMs ?? null,
      launchNonce: record.launchNonce ?? null
    },
    pidPath
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }
    throw error
  }
}

test('normal Windows quit reaps the scoped daemon with a live terminal', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform !== 'win32', 'Windows app-exit lifecycle only')

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActivePanePtyId(orcaPage)

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const { identity, pidPath } = readDaemonIdentity(userDataDir)
  expect(identity.startedAtMs).not.toBeNull()
  expect(identity.launchNonce).not.toBeNull()
  expect(isProcessAlive(identity.pid)).toBe(true)

  const appProcess = electronApp.process()
  const appExited = new Promise<void>((resolve) => appProcess.once('exit', () => resolve()))
  await electronApp.evaluate(({ app }) => {
    setImmediate(() => app.quit())
  })
  await appExited

  await expect
    .poll(
      () => ({
        daemonAlive: isProcessAlive(identity.pid),
        pidRecordExists: existsSync(pidPath)
      }),
      { timeout: 10_000 }
    )
    .toEqual({ daemonAlive: false, pidRecordExists: false })
})
