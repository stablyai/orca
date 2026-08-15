import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  collectCodexEchoLatencyReport,
  installCodexEchoLatencyProbe,
  summarizeLatencies,
  type CodexEchoProbeReport,
  type LatencyDistribution
} from './codex-composer-echo-latency-probe'
import { seedVaultTranscriptBatch, typingEchoScript } from './ai-vault-typing-bench-corpus'
import {
  readVaultRefreshDuration,
  startRendererJankProbe,
  stopRendererJankProbe,
  triggerVaultRefresh,
  type RendererJank
} from './ai-vault-typing-bench-renderer-probe'

const BENCH_ENABLED = process.env.ORCA_AI_VAULT_TYPING_BENCH === '1'
const RESULTS_DIR = path.resolve(__dirname, '..', 'tools', 'benchmarks', 'results')

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const ITERATIONS = readPositiveInt('ORCA_AI_VAULT_BENCH_ITERATIONS', 3)
const SESSION_COUNT = readPositiveInt('ORCA_AI_VAULT_BENCH_SESSIONS', 300)
const PAYLOAD_KIB = readPositiveInt('ORCA_AI_VAULT_BENCH_PAYLOAD_KIB', 128)
const KEY_COUNT = readPositiveInt('ORCA_AI_VAULT_BENCH_KEYS', 100)
const KEY_CADENCE_MS = readPositiveInt('ORCA_AI_VAULT_BENCH_CADENCE_MS', 30)
const BENCH_LABEL = process.env.ORCA_AI_VAULT_BENCH_LABEL ?? 'dev'
const TYPING_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

type ArmResult = {
  iteration: number
  scenario: 'control' | 'vault-refresh'
  order: number
  refreshDurationMs: number | null
  echo: CodexEchoProbeReport
  parse: LatencyDistribution
  render: LatencyDistribution
  missingEchoCount: number
  rendererJank: RendererJank
}

async function openAiVaultSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setRightSidebarOpen(true)
    store.getState().setRightSidebarTab('vault')
  })
  const refresh = page.getByRole('button', { name: 'Refresh Session History' })
  await expect(refresh).toBeVisible()
  await expect(refresh).toBeEnabled({ timeout: 30_000 })
}

async function typeAtCadence(page: Page, target: string): Promise<void> {
  for (const char of target) {
    const startedAt = performance.now()
    await page.keyboard.type(char)
    const remaining = KEY_CADENCE_MS - (performance.now() - startedAt)
    if (remaining > 0) {
      await page.waitForTimeout(remaining)
    }
  }
}

async function runArm(args: {
  page: Page
  ptyId: string
  scriptPath: string
  iteration: number
  scenario: ArmResult['scenario']
  order: number
}): Promise<ArmResult> {
  const readyMarker = `VAULT_TYPING_READY_${randomUUID()}`
  writeFileSync(args.scriptPath, typingEchoScript(readyMarker))
  await sendToTerminal(args.page, args.ptyId, `node ${JSON.stringify(args.scriptPath)}\r`)
  await waitForTerminalOutput(args.page, readyMarker, 15_000)
  const target = TYPING_ALPHABET.repeat(Math.ceil(KEY_COUNT / TYPING_ALPHABET.length)).slice(
    0,
    KEY_COUNT
  )
  await installCodexEchoLatencyProbe(args.page, target)
  await startRendererJankProbe(args.page)
  if (args.scenario === 'vault-refresh') {
    await triggerVaultRefresh(args.page)
  }
  await focusActiveTerminalInput(args.page)
  await typeAtCadence(args.page, target)
  if (args.scenario === 'vault-refresh') {
    await expect(args.page.getByRole('button', { name: 'Refresh Session History' })).toBeEnabled({
      timeout: 120_000
    })
  }
  const refreshDurationMs =
    args.scenario === 'vault-refresh' ? await readVaultRefreshDuration(args.page) : null
  await args.page.waitForTimeout(100)
  const echo = await collectCodexEchoLatencyReport(args.page)
  const rendererJank = await stopRendererJankProbe(args.page)
  await sendToTerminal(args.page, args.ptyId, '\x03').catch(() => undefined)
  const parse = summarizeLatencies(echo.samples.map((sample) => sample.keyToParseMs))
  const render = summarizeLatencies(
    echo.samples.flatMap((sample) => (sample.keyToRenderMs === null ? [] : [sample.keyToRenderMs]))
  )
  return {
    iteration: args.iteration,
    scenario: args.scenario,
    order: args.order,
    refreshDurationMs,
    echo,
    parse,
    render,
    missingEchoCount: KEY_COUNT - echo.samples.length,
    rendererJank
  }
}

function aggregate(arms: ArmResult[], scenario: ArmResult['scenario']): object {
  const selected = arms.filter((arm) => arm.scenario === scenario)
  return {
    parse: summarizeLatencies(
      selected.flatMap((arm) => arm.echo.samples.map((s) => s.keyToParseMs))
    ),
    render: summarizeLatencies(
      selected.flatMap((arm) => arm.echo.samples.flatMap((s) => s.keyToRenderMs ?? []))
    ),
    maxTimerDriftMs: Math.max(...selected.map((arm) => arm.rendererJank.maxTimerDriftMs)),
    maxFrameGapMs: Math.max(...selected.map((arm) => arm.rendererJank.maxFrameGapMs)),
    maxLongTaskMs: Math.max(...selected.map((arm) => arm.rendererJank.maxLongTaskMs)),
    refresh: summarizeLatencies(selected.flatMap((arm) => arm.refreshDurationMs ?? [])),
    missingEchoCount: selected.reduce((sum, arm) => sum + arm.missingEchoCount, 0)
  }
}

function writeReport(testInfo: TestInfo, arms: ArmResult[], seededBytes: number): string {
  const report = {
    benchmark: 'terminal-ai-vault-typing-latency',
    label: BENCH_LABEL,
    timestamp: new Date().toISOString(),
    config: {
      iterations: ITERATIONS,
      sessionCount: SESSION_COUNT,
      payloadKib: PAYLOAD_KIB,
      keyCount: KEY_COUNT,
      keyCadenceMs: KEY_CADENCE_MS
    },
    seededBytes,
    aggregate: {
      control: aggregate(arms, 'control'),
      vaultRefresh: aggregate(arms, 'vault-refresh')
    },
    arms
  }
  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = report.timestamp.replace(/[:.]/g, '-')
  const outPath = path.join(RESULTS_DIR, `ai-vault-typing-${BENCH_LABEL}-${stamp}.json`)
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  testInfo.annotations.push({ type: 'ai-vault-typing-bench', description: outPath })
  console.log(`[ai-vault-typing] report ${outPath}`)
  console.log(`[ai-vault-typing] ${JSON.stringify(report.aggregate)}`)
  return outPath
}

test.describe('Terminal typing during AI Vault refresh bench', () => {
  test.setTimeout(10 * 60 * 1000)

  test('alternates control typing and forced Vault refresh typing', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.skip(!BENCH_ENABLED, 'Bench-only: run via pnpm bench:ai-vault-typing')
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await openAiVaultSidebar(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const homePath = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const scriptPath = path.join(testRepoPath, `.orca-vault-typing-${randomUUID()}.mjs`)
    const arms: ArmResult[] = []
    let seededBytes = 0

    try {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const batch = seedVaultTranscriptBatch({
          homePath,
          cwd: testRepoPath,
          batch: iteration,
          sessionCount: SESSION_COUNT,
          payloadBytes: PAYLOAD_KIB * 1024
        })
        seededBytes += batch.totalBytes
        const scenarios: ArmResult['scenario'][] =
          iteration % 2 === 0 ? ['control', 'vault-refresh'] : ['vault-refresh', 'control']
        for (const [order, scenario] of scenarios.entries()) {
          arms.push(await runArm({ page: orcaPage, ptyId, scriptPath, iteration, scenario, order }))
          if (scenario === 'vault-refresh') {
            await expect(
              orcaPage.getByText(batch.newestTitle, { exact: true }).first()
            ).toBeVisible({
              timeout: 30_000
            })
          }
        }
      }
      writeReport(testInfo, arms, seededBytes)
      expect(arms.every((arm) => arm.missingEchoCount === 0)).toBe(true)
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      rmSync(scriptPath, { force: true })
    }
  })
})
