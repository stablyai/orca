import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { quoteStartupArg } from '../../src/shared/tui-agent-startup-shell'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { getTerminalContent, sendToTerminal, waitForActivePanePtyId } from './helpers/terminal'
import {
  cleanupAccumulatedWorkspaceFixture,
  seedAccumulatedWorkspaceFixture
} from './accumulated-workspace-fixture'
import type { TerminalLoadPane } from './artificial-opencode-pane-interactions'
import { launchIsolatedCodexComposer } from './codex-typing-launch'
import { measurePacedCodexTyping } from './codex-paced-typing'
import {
  sustainedLoadReadyFilePath,
  writeSustainedAgentLoadScript
} from './sustained-agent-typing-load-scripts'
import { createTypingLoadWorkspaces, removeTypingLoadWorkspaces } from './typing-load-workspaces'
import { readTypingScaleCensus } from './typing-scale-census'
import { withTypingRendererCpuProfile } from './typing-renderer-cpu-profile'

function knob(name: string, fallback: number): number {
  const value = Number(process.env[`ORCA_TYPING_BENCH_${name}`])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const enabled = process.env.ORCA_TYPING_BENCH === '1' && process.env.ORCA_E2E_REAL_CODEX === '1'
const keyCount = knob('KEYS', 120)
const cadenceMs = knob('KEY_CADENCE_MS', 100)
const loadPanes = knob('LOAD_PANES', 23)
const loadWorkspaces = knob('LOAD_WORKSPACES', 4)
const rateKbps = knob('RATE_KBPS', 1)
const lifecycleMs = knob('LIFECYCLE_MS', 2_000)
const titleChangeMs = knob('TITLE_CHANGE_MS', 2_000)

// Experimental oracle: every scheduled key reaches the real composer's buffer and renderer.
// Latencies are artifacts, not calibrated gates; local hidden-window paint is a coverage gap.
test.describe('real Codex typing with accumulated background workspaces', () => {
  test.skip(!enabled, 'Opt in with ORCA_TYPING_BENCH=1 ORCA_E2E_REAL_CODEX=1')
  test.skip(process.platform === 'win32', 'Local benchmark launch currently uses a POSIX shell')
  test.setTimeout(10 * 60 * 1000)

  test('records scheduled key echo under real PTY status and title traffic', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const typingWorktreeId = await waitForActiveWorktree(orcaPage)
    const loadWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== typingWorktreeId)
    if (!loadWorktreeId) {
      throw new Error('Seeded secondary workspace unavailable')
    }
    const scratch = mkdtempSync(path.join(tmpdir(), 'orca-codex-typing-'))
    const runId = randomUUID()
    const loadPath = path.join(scratch, 'background-load.mjs')
    const createdIds: string[] = []
    let panes: TerminalLoadPane[] = []
    let typingPtyId: string | undefined
    writeSustainedAgentLoadScript(loadPath, runId, scratch)
    try {
      await switchToWorktree(orcaPage, loadWorktreeId)
      panes = await createTypingLoadWorkspaces(
        orcaPage,
        loadWorktreeId,
        loadPanes,
        loadWorkspaces,
        knob('VISITED_WORKSPACES', 23),
        createdIds
      )
      const durationS = Math.ceil((keyCount * cadenceMs) / 1000) + 180
      for (const [index, pane] of panes.entries()) {
        await sendToTerminal(
          orcaPage,
          pane.ptyId,
          `node ${quoteStartupArg(loadPath, 'posix')} ${index} ${rateKbps} ${durationS} 1 ${titleChangeMs} ${lifecycleMs}\r`
        )
      }
      await expect
        .poll(
          () =>
            panes.filter((_, index) =>
              existsSync(sustainedLoadReadyFilePath(scratch, runId, index))
            ).length,
          { timeout: 30_000 }
        )
        .toBe(loadPanes)
      await switchToWorktree(orcaPage, typingWorktreeId)
      await ensureTerminalVisible(orcaPage)
      typingPtyId = await waitForActivePanePtyId(orcaPage)
      const fixture = await seedAccumulatedWorkspaceFixture(orcaPage)
      await orcaPage.evaluate(() =>
        window.__store?.setState({
          worktreeCardProperties: ['status', 'inline-agents'],
          agentActivityDisplayMode: 'full'
        })
      )
      const composer = await launchIsolatedCodexComposer(orcaPage, typingPtyId, scratch)
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              () =>
                Object.values(window.__store?.getState().agentStatusByPaneKey ?? {}).filter(
                  (row) => row.prompt === 'Synthetic production-path typing workload'
                ).length
            ),
          { timeout: 30_000 }
        )
        .toBe(loadPanes)
      const deliveryBefore = await orcaPage.evaluate(() =>
        window.api.pty.getRendererDeliveryDebugSnapshot()
      )
      const measurement = await withTypingRendererCpuProfile(
        orcaPage,
        process.env.ORCA_TYPING_BENCH_CPU_PROFILE,
        () => measurePacedCodexTyping(orcaPage, { keyCount, cadenceMs })
      )
      const deliveryAfter = await orcaPage.evaluate(() =>
        window.api.pty.getRendererDeliveryDebugSnapshot()
      )
      const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
      const terminalTranscriptTail = await getTerminalContent(orcaPage, 8_000)
      const label = process.env.ORCA_TYPING_BENCH_LABEL ?? 'dev'
      const report = {
        benchmark: 'real-codex-background-typing',
        label,
        timestamp: new Date().toISOString(),
        codexVersion,
        mainSha256: createHash('sha256').update(readFileSync('out/main/index.js')).digest('hex'),
        config: {
          keyCount,
          cadenceMs,
          loadPanes,
          loadWorkspaces,
          rateKbps,
          lifecycleMs,
          titleChangeMs
        },
        composer,
        fixture,
        census: await readTypingScaleCensus(orcaPage),
        deliveryBefore,
        deliveryAfter,
        producers: panes.map((_, index) =>
          JSON.parse(
            readFileSync(path.join(scratch, `.orca-mwt-load-stats-${runId}-${index}`), 'utf8')
          )
        ),
        measurement,
        terminalTranscriptTail
      }
      const directory = path.resolve('.tmp', 'typing-reproduction')
      mkdirSync(directory, { recursive: true })
      const reportPath = path.join(directory, `codex-${label}-${Date.now()}.json`)
      writeFileSync(reportPath, JSON.stringify(report, null, 2))
      await orcaPage.screenshot({ path: reportPath.replace(/\.json$/, '.png') })
      testInfo.annotations.push({ type: 'codex-background-typing', description: reportPath })
      console.log(
        `[codex-background-typing] ${reportPath} ${JSON.stringify({
          plannedToParseMs: measurement.plannedToParseMs,
          plannedToRenderMs: measurement.plannedToRenderMs,
          diagnostics: measurement.diagnostics
        })}`
      )
      expect(measurement.samples.length).toBe(keyCount)
      expect(measurement.keysObserved).toBe(keyCount)
      expect(measurement.plannedToRenderMs.count).toBe(keyCount)
      expect(deliveryAfter.hiddenDeliveryDroppedChars).toBeGreaterThan(
        deliveryBefore.hiddenDeliveryDroppedChars
      )
    } finally {
      if (typingPtyId) {
        await sendToTerminal(orcaPage, typingPtyId, '\x03\x03').catch(() => undefined)
      }
      await cleanupAccumulatedWorkspaceFixture(orcaPage).catch(() => undefined)
      for (const pane of panes) {
        await sendToTerminal(orcaPage, pane.ptyId, '\x03').catch(() => undefined)
      }
      await switchToWorktree(orcaPage, typingWorktreeId).catch(() => undefined)
      await removeTypingLoadWorkspaces(orcaPage, createdIds)
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
