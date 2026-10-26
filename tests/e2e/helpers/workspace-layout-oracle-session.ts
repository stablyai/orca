import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import { PROTOCOL_VERSION } from '../../../src/main/daemon/types'
import { expect } from './orca-app'
import { createRestartSession } from './orca-restart'
import { bootstrapRestoredLaunch } from './terminal-restart-persistence'
import { waitForPaneCount } from './terminal'
import { LayoutOracle, type OracleFinding } from './workspace-layout-oracle'
import { LiveLayoutFeed } from './workspace-layout-oracle-feed'
import { subscribeWindowLayout } from './workspace-layout-oracle-stream'
import { readSavedPartitions } from './workspace-layout-oracle-views'
import { summarizeEventLoopDelay, type EventLoopDelaySummary } from './event-loop-delay-report'

export const ORACLE_REPORT_DIR_ENV = 'ORCA_LAYOUT_ORACLE_REPORT_DIR'

export type OracleRun = {
  page: Page
  userDataDir: string
  client: RuntimeClient
  oracle: LayoutOracle
  /** Worktrees the client checks compare; scenarios add the ones they create. */
  worktreeIds: string[]
  /** Reloads the window's renderer (main keeps running) and re-arms the window checks. */
  reloadWindow: () => Promise<void>
  /** Quit, optionally kill the PTY daemon, relaunch, and diff the layout against before. */
  relaunch: (options: {
    worktreeId: string
    paneCount: number
    coldDaemon?: boolean
    /** Panes per terminal tab the relaunched runtime must hold. */
    panesPerTab: number[]
    /** The relaunch restarts terminals (a slept agent woken on reopen). */
    terminalsRestart?: true
    /** Quit right after the last command, with no settle: the quit-time save must carry it. */
    quitWithoutSettling?: true
    reopen?: (page: Page, worktreeId: string) => Promise<void>
  }) => Promise<void>
}

function readDaemonPid(userDataDir: string): number | null {
  try {
    const raw = readFileSync(
      path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
      'utf8'
    )
    const pid: unknown = JSON.parse(raw).pid
    return typeof pid === 'number' ? pid : null
  } catch {
    return null
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error
    }
  }
}

export async function runOracleScenario(
  testInfo: TestInfo,
  scenarioId: string,
  body: (run: OracleRun) => Promise<void>
): Promise<OracleFinding[]> {
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  const worktreeIds: string[] = []
  const started = Date.now()
  try {
    const first = await session.launch()
    app = first.app
    const feed = new LiveLayoutFeed((current) => run.oracle.checkFrame(current))
    const target = (page: Page, client: RuntimeClient) => ({
      page,
      client,
      feed,
      readSavedPartitions: async () => {
        // Main debounces saves by up to 5 s; flushing makes the read the state main holds now.
        await page.evaluate(() => window.api.session.flush())
        return readSavedPartitions(session.userDataDir)
      },
      worktreeIds: () => worktreeIds
    })
    const client = new RuntimeClient(session.userDataDir, 30_000)
    const run: OracleRun = {
      page: first.page,
      userDataDir: session.userDataDir,
      client,
      oracle: new LayoutOracle(target(first.page, client), scenarioId),
      worktreeIds,
      reloadWindow: async () => {
        await run.page.reload()
        await run.page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
        await subscribeWindowLayout(run.page, feed)
        await run.oracle.retarget(target(run.page, run.client))
      },
      relaunch: async (options) => {
        const { worktreeId, paneCount, coldDaemon, panesPerTab, reopen } = options
        if (!options.quitWithoutSettling) {
          run.oracle.rememberForRestart(await run.oracle.step('before relaunch', null))
        }
        await session.close(app!)
        app = null
        const daemonPid = coldDaemon ? readDaemonPid(session.userDataDir) : null
        if (coldDaemon) {
          expect(daemonPid, 'the PTY daemon pid file is missing').not.toBeNull()
          killProcess(daemonPid!)
        }
        const next = await session.launch()
        app = next.app
        run.page = next.page
        run.client = new RuntimeClient(session.userDataDir, 30_000)
        await subscribeWindowLayout(next.page, feed)
        await run.oracle.retarget(target(next.page, run.client))
        if (reopen) {
          await reopen(next.page, worktreeId)
          await waitForPaneCount(next.page, paneCount, 30_000).catch(() => {})
        } else {
          await bootstrapRestoredLaunch(next.page, worktreeId, paneCount)
        }
        const restartsTerminals = coldDaemon || options.terminalsRestart
        const after = await run.oracle.step(
          coldDaemon ? 'after cold relaunch' : 'after relaunch',
          { worktreeId, panesPerTab, ...(restartsTerminals ? { terminalsRestart: true } : {}) },
          { allowRemount: true }
        )
        if (!options.quitWithoutSettling) {
          run.oracle.compareRestart(coldDaemon ? 'cold relaunch' : 'relaunch', after, {
            maskPtyIds: coldDaemon
          })
        }
      }
    }
    await subscribeWindowLayout(first.page, feed)
    await run.oracle.start()
    await body(run)
    writeReport(testInfo, scenarioId, {
      findings: run.oracle.findings,
      viewCreations: run.oracle.viewCreations.at(-1) ?? {},
      eventLoopDelay: summarizeEventLoopDelay(session.userDataDir, 'main', started, Date.now())
    })
    return run.oracle.findings
  } finally {
    await session.dispose(app ?? undefined)
  }
}

function writeReport(
  testInfo: TestInfo,
  scenarioId: string,
  report: {
    findings: OracleFinding[]
    viewCreations: Record<string, number>
    /** Main's event-loop delay over the scenario. */
    eventLoopDelay: EventLoopDelaySummary
  }
): void {
  const dir = process.env[ORACLE_REPORT_DIR_ENV] ?? testInfo.outputPath('layout-oracle')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${scenarioId}-${Date.now()}.json`)
  writeFileSync(file, `${JSON.stringify({ scenario: scenarioId, ...report }, null, 2)}\n`)
}
