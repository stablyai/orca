import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  probeMotion,
  installWriteProbe,
  readWriteProbe,
  hostSnapshot
} from './helpers/mouse-owner-replay-probes'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'

function checkpoints(userDataDir: string) {
  const directory = path.join(userDataDir, 'terminal-history')
  return readdirSync(directory).flatMap((name) => {
    try {
      return [
        {
          name,
          checkpoint: JSON.parse(
            readFileSync(path.join(directory, name, 'checkpoint.json'), 'utf8')
          )
        }
      ]
    } catch {
      return []
    }
  })
}

const cases = [
  { name: 'serve-restart', screen: 'alt', title: 'Claude Code', shell: 'bare', kill: 'before' },
  { name: 'serve-shutdown', screen: 'alt', title: 'Claude Code', shell: 'bare', kill: 'during' },
  { name: 'cold', screen: 'alt', title: 'Claude Code', shell: 'bare', kill: 'before' },
  { name: 'cold-live', screen: 'alt', title: 'Claude Code', shell: 'bare', kill: 'during' },
  { name: 'cold-normal', screen: 'normal', title: 'Claude Code', shell: 'bare', kill: 'during' },
  { name: 'cold-no-title', screen: 'alt', title: 'none', shell: 'bare', kill: 'during' },
  {
    name: 'cold-integrated',
    screen: 'alt',
    title: 'Claude Code',
    shell: 'integrated',
    kill: 'before'
  }
] as const

for (const scenario of cases) {
  const boundary = scenario.name
  test(`mouse owner proof: ${boundary} serve restart`, async ({ testRepoPath }, testInfo) => {
    test.skip(process.env.ORCA_MOUSE_PROOF_LOCAL !== '1', 'Opt-in issue #18424 reproduction matrix')
    test.skip(process.platform === 'win32', 'POSIX SIGKILL and bash reproduction')
    test.setTimeout(180_000)
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-mouse-owner-'))
    const pidFile = path.join(scratch, 'owner.pid')
    const inputFile = path.join(scratch, 'input.jsonl')
    let disposeHost: (() => Promise<void>) | undefined
    let disposeClient: (() => Promise<void>) | undefined
    const observations: Record<string, unknown> = {}
    try {
      const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
      disposeHost = () => host.dispose()
      const client = await launchPairedElectronClient(
        host.offer,
        testInfo,
        `mouse-owner-${boundary}`
      )
      disposeClient = () => client.dispose()
      const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: testRepoPath,
        kind: 'folder'
      })
      const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
        repo: `id:${added.result.repo.id}`
      })
      const worktreeId = listed.result.worktrees[0].id
      const created = await host.client.call<{ terminal: { handle: string; tabId: string } }>(
        'terminal.create',
        {
          worktree: `id:${worktreeId}`,
          ...(scenario.shell === 'bare' ? { command: 'bash --noprofile --norc' } : {}),
          focus: false
        }
      )
      const terminal = created.result.terminal
      const tabId = toWebTerminalSurfaceTabId(terminal.tabId)
      await client.page.evaluate(
        ({ worktreeId, environmentId }) => {
          const state = window.__store?.getState()
          state?.setActiveView('terminal')
          state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
        },
        { worktreeId, environmentId: client.environmentId }
      )
      const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
      await tab.click({ timeout: 60_000 })
      await expect(client.page.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 })
      await installWriteProbe(client.page, tabId)
      const command = `PS1='ORCA_BARE_SHELL> '; ${[
        process.execPath,
        path.join(__dirname, 'fixtures', 'mouse-mode-owner.cjs'),
        pidFile,
        inputFile,
        scenario.screen,
        scenario.title
      ]
        .map(quotePosixShell)
        .join(' ')}`
      await host.client.call('terminal.send', {
        terminal: terminal.handle,
        text: command,
        enter: true
      })
      await expect
        .poll(() => probeMotion(client.page, tabId), { timeout: 20_000 })
        .toMatchObject({ mode: 'any' })
      observations.live = await probeMotion(client.page, tabId)
      expect(JSON.stringify(observations.live)).toContain('\\u001b[<')
      await expect
        .poll(() => readFileSync(inputFile, 'utf8'), { timeout: 10_000 })
        .toContain('\\u001b[<')
      const ownerPid = Number(readFileSync(pidFile, 'utf8'))
      const shellPid = Number(
        execFileSync('ps', ['-p', String(ownerPid), '-o', 'ppid='], { encoding: 'utf8' }).trim()
      )
      observations.processBefore = execFileSync(
        'ps',
        ['-p', `${ownerPid},${shellPid}`, '-o', 'pid,ppid,command'],
        { encoding: 'utf8' }
      )
      await client.page.waitForTimeout(6000)
      observations.checkpointsBefore = checkpoints(host.userDataDir)
      if (scenario.kill === 'before') {
        process.kill(ownerPid, 'SIGKILL')
        await expect
          .poll(() => probeMotion(client.page, tabId), { timeout: 15_000 })
          .toMatchObject({ text: expect.stringContaining('ORCA_BARE_SHELL>') })
        observations.afterKill = await probeMotion(client.page, tabId)
        observations.processAfterKill = execFileSync(
          'ps',
          ['-p', String(shellPid), '-o', 'pid,ppid,command'],
          { encoding: 'utf8' }
        )
      }
      await client.page.screenshot({ path: testInfo.outputPath('after-kill.png') })
      observations.writesBeforeRestart = await readWriteProbe(client.page, true)
      await host.restartServeProcess({
        betweenProcesses: boundary.startsWith('cold')
          ? () => cleanupE2EDaemons(host.userDataDir)
          : undefined
      })
      await expect
        .poll(
          async () => {
            try {
              const result = await host.client.call<{ terminals: unknown[] }>('terminal.list', {})
              return result.result.terminals.length
            } catch {
              return 0
            }
          },
          { timeout: 30_000 }
        )
        .toBeGreaterThan(0)
      await expect(client.page.locator('.xterm-screen')).toBeVisible({ timeout: 45_000 })
      await client.page.waitForTimeout(3000)
      observations.afterRestart = await probeMotion(client.page, tabId)
      observations.hostProcessesAfterRestart = (await host.client.call('terminal.list', {})).result
      const currentTerminals = await host.client.call<{ terminals: { handle: string }[] }>(
        'terminal.list',
        {}
      )
      observations.hostSnapshotAfterRestart = await hostSnapshot(
        client.page,
        client.environmentId,
        currentTerminals.result.terminals[0].handle
      )
      observations.hostProcessAfterRestart = (
        await host.client.call('terminal.inspectProcess', {
          terminal: currentTerminals.result.terminals[0].handle,
          scanChildProcesses: true
        })
      ).result
      observations.checkpointsAfter = checkpoints(host.userDataDir)
      observations.writesAfterRestart = await readWriteProbe(client.page)
      await client.page.screenshot({ path: testInfo.outputPath('after-restart.png') })
      await client.page.reload()
      await expect(client.page.locator('.xterm-screen')).toBeVisible({ timeout: 45_000 })
      await client.page.waitForTimeout(1000)
      observations.afterReload = await probeMotion(client.page, tabId)
      await client.page.screenshot({ path: testInfo.outputPath('after-reload.png') })
      await testInfo.attach('observations', {
        body: JSON.stringify(observations, null, 2),
        contentType: 'application/json'
      })
      console.log(
        JSON.stringify({
          boundary,
          afterKill: observations.afterKill,
          afterRestart: observations.afterRestart,
          afterReload: observations.afterReload
        })
      )
      expect(observations.afterRestart).toMatchObject({
        mode: 'none',
        focusReporting: false,
        reports: []
      })
      expect(observations.afterReload).toMatchObject({ mode: 'none', reports: [] })
      await expect(client.page.locator('.xterm.enable-mouse-events:visible')).toHaveCount(0)
    } finally {
      try {
        writeFileSync(
          testInfo.outputPath('observations.json'),
          JSON.stringify(observations, null, 2)
        )
        await testInfo.attach('observations-final', {
          body: JSON.stringify(observations, null, 2),
          contentType: 'application/json'
        })
      } finally {
        try {
          await disposeClient?.()
        } finally {
          try {
            await disposeHost?.()
          } finally {
            rmSync(scratch, { recursive: true, force: true })
          }
        }
      }
    }
  })
}
