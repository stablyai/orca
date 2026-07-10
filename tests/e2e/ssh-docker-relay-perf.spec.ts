import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const KEY_LATENCY_SAMPLES = 'abcdefghij'
const MAX_MEDIAN_KEY_LATENCY_MS = 500
const MAX_WORST_KEY_LATENCY_MS = 2_000

type TypingMeasurement = {
  latencies: number[]
  medianLatencyMs: number
  worstLatencyMs: number
}

type ConnectedDockerRemote = {
  targetId: string
  repoId: string
  worktreeId: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function remoteTypingLoadScript(runId: string): string {
  return [
    "process.stdin.setEncoding('utf8')",
    'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
    'process.stdin.resume()',
    'let seq = 0',
    'let frame = 0',
    'let bg = null',
    `process.stdout.write('REMOTE_TUI_READY_${runId}\\n')`,
    "setTimeout(() => { bg = setInterval(() => { frame += 1; process.stdout.write('BG_' + frame + '_' + 'x'.repeat(4096) + '\\n') }, 8) }, 500)",
    "process.stdin.on('data', (chunk) => {",
    '  if (chunk.includes(String.fromCharCode(3))) { if (bg) clearInterval(bg); process.exit(0) }',
    '  for (const char of chunk) {',
    "    if (char === '\\r' || char === '\\n') continue",
    '    seq += 1',
    `    process.stdout.write('\\x1b[20;2HREMOTE_KEY_${runId}_' + seq + '_' + char + '\\n')`,
    '  }',
    '})'
  ].join(';')
}

async function connectDockerRemote(
  page: Page,
  target: DockerSshRelayTarget
): Promise<ConnectedDockerRemote> {
  return await page.evaluate(
    async ({ target, remotePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const createdTarget = await window.api.ssh.addTarget({
          target: {
            label: `Docker SSH Relay Perf ${Date.now()}`,
            host: '127.0.0.1',
            port: target.port,
            username: 'root',
            identityFile: target.identityFile,
            identitiesOnly: true,
            relayGracePeriodSeconds: 1
          }
        })
        const state = await window.api.ssh.connect({ targetId: createdTarget.id })
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(createdTarget.id, state)
        const labels = new Map(store.getState().sshTargetLabels)
        labels.set(createdTarget.id, createdTarget.label)
        store.getState().setSshTargetLabels(labels)

        const result = await window.api.repos.addRemote({
          connectionId: createdTarget.id,
          remotePath,
          displayName: 'Docker SSH Relay Perf'
        })
        if ('error' in result) {
          throw new Error(result.error)
        }
        await store.getState().fetchRepos()
        await store.getState().fetchWorktrees(result.repo.id)
        const worktree = (store.getState().worktreesByRepo[result.repo.id] ?? [])[0]
        if (!worktree) {
          throw new Error(`No remote worktree found for ${result.repo.path}`)
        }
        store.getState().setActiveWorktree(worktree.id)
        if ((store.getState().tabsByWorktree[worktree.id] ?? []).length === 0) {
          store.getState().createTab(worktree.id)
        }
        store.getState().setActiveTabType('terminal')
        return {
          targetId: createdTarget.id,
          repoId: result.repo.id,
          worktreeId: worktree.id
        }
      } finally {
        credentialUnsub()
      }
    },
    { target, remotePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH }
  )
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function measureRemoteTyping(
  page: Page,
  ptyId: string,
  runId: string
): Promise<TypingMeasurement> {
  const latencies: number[] = []
  for (let index = 0; index < KEY_LATENCY_SAMPLES.length; index += 1) {
    const char = KEY_LATENCY_SAMPLES[index]
    const marker = `REMOTE_KEY_${runId}_${index + 1}_${char}`
    const started = performance.now()
    await page.evaluate(({ ptyId, char }) => window.api.pty.write(ptyId, char), { ptyId, char })
    await waitForTerminalOutput(page, marker, 10_000, 80_000)
    latencies.push(performance.now() - started)
  }
  return {
    latencies,
    medianLatencyMs: median(latencies),
    worstLatencyMs: Math.max(...latencies)
  }
}

async function stopRemoteLoad(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((targetPtyId) => window.api.pty.write(targetPtyId, '\x03'), ptyId)
}

async function reconnectDockerTarget(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (targetId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await window.api.ssh.disconnect({ targetId })
    const state = await window.api.ssh.connect({ targetId })
    if (!state || state.status !== 'connected') {
      throw new Error(`SSH target did not reconnect: ${JSON.stringify(state)}`)
    }
    store.getState().setSshConnectionState(targetId, state)
  }, targetId)
}

test.describe('Docker SSH relay perf', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH relay perf.')
  test.skip(process.platform === 'win32', 'Docker SSH relay perf uses POSIX ssh tooling.')

  test('keeps remote typing responsive while the Linux relay streams TUI output', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await connectDockerRemote(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)

      const runId = String(Date.now())
      await execInTerminal(orcaPage, ptyId, `node -e ${shellQuote(remoteTypingLoadScript(runId))}`)
      await waitForTerminalOutput(orcaPage, `REMOTE_TUI_READY_${runId}`, 30_000, 80_000)
      const measurement = await measureRemoteTyping(orcaPage, ptyId, runId)
      const summary = `median=${measurement.medianLatencyMs.toFixed(
        1
      )}ms worst=${measurement.worstLatencyMs.toFixed(1)}ms samples=${measurement.latencies
        .map((value) => value.toFixed(1))
        .join(',')}`
      console.log(`[docker-ssh-relay-perf] ${summary}`)
      testInfo.annotations.push({
        type: 'docker-ssh-relay-typing',
        description: summary
      })
      expect(measurement.medianLatencyMs).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
      expect(measurement.worstLatencyMs).toBeLessThan(MAX_WORST_KEY_LATENCY_MS)
      await stopRemoteLoad(orcaPage, ptyId)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('keeps remote typing responsive while relay file streams and git churn are active', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerRemote(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)

      const runId = String(Date.now())
      // Large remote binaries: each read streams ~8MB of fs.streamChunk frames
      // over the same SSH channel that carries the pty echo.
      const loadFiles = [
        `${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}/stream-load-a.png`,
        `${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}/stream-load-b.png`
      ]
      await execInTerminal(
        orcaPage,
        ptyId,
        `dd if=/dev/urandom of=${shellQuote(loadFiles[0])} bs=1M count=8 status=none && ` +
          `dd if=/dev/urandom of=${shellQuote(loadFiles[1])} bs=1M count=8 status=none && ` +
          `echo LOAD_FILES_READY_${runId}`
      )
      await waitForTerminalOutput(orcaPage, `LOAD_FILES_READY_${runId}`, 60_000, 80_000)

      await execInTerminal(orcaPage, ptyId, `node -e ${shellQuote(remoteTypingLoadScript(runId))}`)
      await waitForTerminalOutput(orcaPage, `REMOTE_TUI_READY_${runId}`, 30_000, 80_000)

      // Background relay pressure: continuous large file reads plus git status
      // refreshes, mirroring file preview + source-control churn while typing.
      await orcaPage.evaluate(
        ({ targetId, files, repoPath }) => {
          const state = { stopped: false, reads: 0, errors: [] as string[] }
          ;(window as unknown as { __sshRelayLoad: typeof state }).__sshRelayLoad = state
          const loop = async (run: () => Promise<unknown>): Promise<void> => {
            while (!state.stopped) {
              try {
                await run()
                state.reads += 1
              } catch (err) {
                state.errors.push(String(err))
                await new Promise((r) => setTimeout(r, 100))
              }
            }
          }
          for (const filePath of files) {
            void loop(() => window.api.fs.readFile({ filePath, connectionId: targetId }))
          }
          void loop(() => window.api.git.status({ worktreePath: repoPath, connectionId: targetId }))
        },
        {
          targetId: remote.targetId,
          files: loadFiles,
          repoPath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
        }
      )
      // Let the bulk load ramp before measuring.
      await orcaPage.waitForTimeout(1_000)

      const measurement = await measureRemoteTyping(orcaPage, ptyId, runId)
      const load = await orcaPage.evaluate(() => {
        const state = (
          window as unknown as {
            __sshRelayLoad: { stopped: boolean; reads: number; errors: string[] }
          }
        ).__sshRelayLoad
        state.stopped = true
        return { reads: state.reads, errors: state.errors.slice(0, 3) }
      })

      const summary =
        `median=${measurement.medianLatencyMs.toFixed(1)}ms ` +
        `worst=${measurement.worstLatencyMs.toFixed(1)}ms ` +
        `bulkReads=${load.reads} ` +
        `samples=${measurement.latencies.map((value) => value.toFixed(1)).join(',')}`
      console.log(`[docker-ssh-relay-perf:busy] ${summary}`)
      testInfo.annotations.push({
        type: 'docker-ssh-relay-typing-busy',
        description: summary
      })

      // The load must actually have been streaming and error-free, otherwise
      // the latency numbers prove nothing.
      expect(load.errors).toEqual([])
      expect(load.reads).toBeGreaterThan(0)
      expect(measurement.medianLatencyMs).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
      expect(measurement.worstLatencyMs).toBeLessThan(MAX_WORST_KEY_LATENCY_MS)
      await stopRemoteLoad(orcaPage, ptyId)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('keeps an SSH workspace terminal usable after disconnect and reconnect', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerRemote(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const beforePtyId = await waitForActivePanePtyId(orcaPage, 60_000)
      const beforeMarker = `SSH_RECONNECT_BEFORE_${Date.now()}`
      await execInTerminal(orcaPage, beforePtyId, `printf ${shellQuote(beforeMarker)}`)
      await waitForTerminalOutput(orcaPage, beforeMarker, 20_000, 60_000)

      await reconnectDockerTarget(orcaPage, remote.targetId)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const afterPtyId = await waitForActivePanePtyId(orcaPage, 60_000)
      const afterMarker = `SSH_RECONNECT_AFTER_${Date.now()}`
      await execInTerminal(orcaPage, afterPtyId, `printf ${shellQuote(afterMarker)}`)
      await waitForTerminalOutput(orcaPage, afterMarker, 20_000, 60_000)

      testInfo.annotations.push({
        type: 'docker-ssh-reconnect',
        description: `terminal survived reconnect: beforePty=${beforePtyId}, afterPty=${afterPtyId}`
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
