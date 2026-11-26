import { ChildProcess } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { rm } from 'node:fs/promises'
import { _electron as electron } from '@stablyai/playwright-test'
import { forceKillProcessTree } from './electron-process-shutdown'
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
  const failedSpawns = new Set<ChildProcess>()
  const profileEnv = `ORCA_E2E_USER_DATA_DIR=${userDataDir}`
  const spawnStart = channel('tracing:child_process.spawn:start')
  const spawnError = channel('tracing:child_process.spawn:error')
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
  const captureSpawnError = (message: unknown): void => {
    if (
      message &&
      typeof message === 'object' &&
      'process' in message &&
      message.process instanceof ChildProcess &&
      launchProcesses.has(message.process)
    ) {
      failedSpawns.add(message.process)
    }
  }

  // Playwright does not return an app handle when startup times out.
  spawnStart.subscribe(captureLaunch)
  spawnError.subscribe(captureSpawnError)
  try {
    return await electron.launch(options)
  } catch (error) {
    try {
      for (const child of launchProcesses) {
        await forceKillProcessTree(child)
      }
      if (
        launchProcesses.size > 0 &&
        [...launchProcesses].every((child) => !child.pid && failedSpawns.has(child))
      ) {
        await removeUserDataDirAfterShutdown(userDataDir)
      } else {
        // An exited root cannot account for reparented profile holders.
        const reason = launchProcesses.size
          ? 'startup children or daemons may still own the profile'
          : 'could not confirm whether a process started'
        console.warn(`[orca-e2e] Retained failed-launch profile ${userDataDir}: ${reason}`)
      }
    } catch (cleanupError) {
      console.warn(`[orca-e2e] Failed-launch profile cleanup at ${userDataDir}`, cleanupError)
    }
    throw error
  } finally {
    spawnStart.unsubscribe(captureLaunch)
    spawnError.unsubscribe(captureSpawnError)
  }
}
