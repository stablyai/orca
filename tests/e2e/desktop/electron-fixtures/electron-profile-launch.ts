import { ChildProcess } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { rm } from 'node:fs/promises'
import { _electron as electron } from '@stablyai/playwright-test'
import { cleanupE2EDaemons, forceKillProcessTree } from './electron-process-shutdown'
import { recordElectronShutdownTiming } from './electron-shutdown-timing'

export async function removeUserDataDirAfterShutdown(userDataDir: string): Promise<void> {
  const started = performance.now()
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
  recordElectronShutdownTiming('profile-removal', started)
}

export async function launchElectronInE2EProfile(
  userDataDir: string,
  options: Parameters<typeof electron.launch>[0]
): ReturnType<typeof electron.launch> {
  const launchProcesses = new Set<ChildProcess>()
  const profileEnv = `ORCA_E2E_USER_DATA_DIR=${userDataDir}`
  const spawnStart = channel('tracing:child_process.spawn:start')
  const captureLaunch = (message: unknown): void => {
    if (
      message &&
      typeof message === 'object' &&
      'process' in message &&
      message.process instanceof ChildProcess &&
      'options' in message &&
      message.options &&
      typeof message.options === 'object' &&
      'envPairs' in message.options &&
      Array.isArray(message.options.envPairs) &&
      message.options.envPairs.includes(profileEnv)
    ) {
      launchProcesses.add(message.process)
    }
  }

  // Playwright does not return an app handle when startup times out.
  spawnStart.subscribe(captureLaunch)
  try {
    return await electron.launch(options)
  } catch (error) {
    try {
      for (const child of launchProcesses) {
        await forceKillProcessTree(child)
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          throw new Error('Electron still owns the failed-launch profile')
        }
      }
      await cleanupE2EDaemons(userDataDir)
      await removeUserDataDirAfterShutdown(userDataDir)
    } catch (cleanupError) {
      console.warn('[orca-e2e] Could not clean up the failed Electron launch', cleanupError)
    }
    throw error
  } finally {
    spawnStart.unsubscribe(captureLaunch)
  }
}
