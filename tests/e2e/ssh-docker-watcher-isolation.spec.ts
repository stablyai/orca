import type { Locator, Page } from '@stablyai/playwright-test'

import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  isDockerSshRelayPidRunning,
  readDockerSshRelayArtifactState,
  readDockerSshRelayProcessSnapshot,
  removeDockerSshRelayWatcherArtifact,
  signalDockerSshRelayWatchers,
  terminateDockerSshRelay,
  type DockerSshRelayProcessSnapshot
} from './helpers/docker-ssh-relay-processes'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  startDockerSshRelayTarget,
  writeDockerSshRelayTargetFile,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { openFileExplorer } from './helpers/file-explorer'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function remoteRepoFile(fileName: string): string {
  return `${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}/${fileName}`
}

function fileExplorerRow(page: Page, fileName: string): Locator {
  return page.locator('[data-file-explorer-row]').filter({ hasText: fileName })
}

async function waitForRelayWatcherProcessGroup(
  target: DockerSshRelayTarget
): Promise<DockerSshRelayProcessSnapshot> {
  let snapshot: DockerSshRelayProcessSnapshot | null = null
  await expect
    .poll(
      () => {
        snapshot = readDockerSshRelayProcessSnapshot(target)
        return snapshot !== null
      },
      { timeout: 30_000, message: 'remote relay/watcher process group did not appear' }
    )
    .toBe(true)
  if (!snapshot) {
    throw new Error('remote relay/watcher process group disappeared after polling')
  }
  return snapshot
}

async function openRemoteFileExplorer(page: Page, target: DockerSshRelayTarget): Promise<void> {
  await openFileExplorer(page)
  await expect(page.locator('[data-orca-explorer-shell]')).toBeVisible({ timeout: 15_000 })
  await expect(fileExplorerRow(page, 'README.md')).toBeVisible({ timeout: 30_000 })
  // Why: the child appears only after the real explorer watch subscribes, so
  // external file creation below cannot race the initial watch registration.
  await waitForRelayWatcherProcessGroup(target)
}

async function closeRemoteFileExplorer(page: Page): Promise<void> {
  await page.evaluate(() => window.__store?.getState().setRightSidebarOpen(false))
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().rightSidebarOpen ?? true), {
      timeout: 5_000
    })
    .toBe(false)
}

async function enableTerminalAccessibilityDom(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((ptyId) => {
    const managers = Array.from(window.__paneManagers?.values() ?? [])
    const pane = managers
      .flatMap((manager) => manager.getPanes?.() ?? [])
      .find((candidate) => candidate.container.dataset.ptyId === ptyId)
    if (!pane) {
      throw new Error(`Terminal pane ${ptyId} is unavailable`)
    }
    // Why: xterm normally paints to canvas. Screen-reader mode mirrors the
    // user-visible buffer into DOM rows so the survival assertion stays DOM-based.
    pane.terminal.options.screenReaderMode = true
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  }, ptyId)
  await expect(
    page.locator(`[data-pty-id=${JSON.stringify(ptyId)}] .xterm-accessibility-tree`)
  ).toBeAttached({ timeout: 10_000 })
}

test.describe('Docker SSH relay watcher isolation', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH watcher isolation uses POSIX tooling.')

  test('keeps the relay, terminal, and explorer alive when only relay-watcher.js crashes', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      await enableTerminalAccessibilityDom(orcaPage, ptyId)
      await openRemoteFileExplorer(orcaPage, target)

      const beforeFile = 'before-crash.txt'
      writeDockerSshRelayTargetFile(target, remoteRepoFile(beforeFile), 'before watcher crash\n')
      await expect(fileExplorerRow(orcaPage, beforeFile)).toBeVisible({ timeout: 30_000 })

      const beforeCrash = await waitForRelayWatcherProcessGroup(target)
      // Why: the relay shards roots across bounded watcher children. Crashing
      // every verified child guarantees the explorer's shard crosses the boundary.
      signalDockerSshRelayWatchers(target, beforeCrash)

      let afterCrash: DockerSshRelayProcessSnapshot | null = null
      await expect
        .poll(
          () => {
            afterCrash = readDockerSshRelayProcessSnapshot(target!)
            return Boolean(
              afterCrash &&
              afterCrash.relayPid === beforeCrash.relayPid &&
              afterCrash.watcherPids.every(
                (watcherPid) => !beforeCrash.watcherPids.includes(watcherPid)
              )
            )
          },
          {
            timeout: 30_000,
            message: 'watcher children were not replaced under the same relay PID'
          }
        )
        .toBe(true)

      const terminalMarker = `SSH_WATCHER_CRASH_SURVIVED_${Date.now()}`
      // Why: the shell echoes input before executing it. Encoding keeps the
      // plaintext marker exclusive to command output, proving a live remote PTY.
      const terminalMarkerBase64 = Buffer.from(terminalMarker).toString('base64')
      const afterFile = 'after-crash.txt'
      await execInTerminal(
        orcaPage,
        ptyId,
        `printf '%s' ${shellQuote(terminalMarkerBase64)} | base64 -d && printf '\\n' && ` +
          `printf '%s\\n' 'after watcher crash' > ${shellQuote(remoteRepoFile(afterFile))}`
      )
      const terminalDom = orcaPage.locator(
        `[data-pty-id=${JSON.stringify(ptyId)}] .xterm-accessibility-tree`
      )
      await expect(terminalDom).toContainText(terminalMarker, { timeout: 30_000 })

      const finalProcesses = await waitForRelayWatcherProcessGroup(target)
      expect(finalProcesses.relayPid).toBe(beforeCrash.relayPid)
      expect(
        finalProcesses.watcherPids.some((watcherPid) =>
          beforeCrash.watcherPids.includes(watcherPid)
        )
      ).toBe(false)
      testInfo.annotations.push({
        type: 'docker-ssh-watcher-isolation',
        description:
          `target=${remote.targetId} relayPid=${beforeCrash.relayPid} ` +
          `watcherPids=${beforeCrash.watcherPids.join(',')}->${finalProcesses.watcherPids.join(',')} ` +
          `pty=${ptyId}`
      })
      await expect(fileExplorerRow(orcaPage, afterFile)).toBeVisible({ timeout: 30_000 })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('repairs a missing deployed relay-watcher.js on reconnect', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await openRemoteFileExplorer(orcaPage, target)

      const beforeRepair = await waitForRelayWatcherProcessGroup(target)
      expect(readDockerSshRelayArtifactState(target, beforeRepair.relayDir)).toEqual({
        installComplete: true,
        relayWatcher: true
      })
      removeDockerSshRelayWatcherArtifact(target, beforeRepair.relayDir)
      expect(readDockerSshRelayArtifactState(target, beforeRepair.relayDir)).toEqual({
        installComplete: true,
        relayWatcher: false
      })

      await closeRemoteFileExplorer(orcaPage)
      await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      // Why: normal relays deliberately retain PTYs for the reconnect grace
      // window. Stop this disconnected instance so reconnect must deploy anew.
      terminateDockerSshRelay(target, beforeRepair)
      await expect
        .poll(() => isDockerSshRelayPidRunning(target!, beforeRepair.relayPid), {
          timeout: 30_000,
          message: 'disconnected relay did not exit after explicit termination'
        })
        .toBe(false)
      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)

      await openRemoteFileExplorer(orcaPage, target)
      const afterRepair = await waitForRelayWatcherProcessGroup(target)
      expect(afterRepair.relayPid).not.toBe(beforeRepair.relayPid)
      expect(readDockerSshRelayArtifactState(target, afterRepair.relayDir)).toEqual({
        installComplete: true,
        relayWatcher: true
      })
      const repairedFile = 'after-artifact-repair.txt'
      writeDockerSshRelayTargetFile(target, remoteRepoFile(repairedFile), 'artifact repaired\n')
      await expect(fileExplorerRow(orcaPage, repairedFile)).toBeVisible({ timeout: 30_000 })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
