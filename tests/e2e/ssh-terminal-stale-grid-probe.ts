import type { Page, TestInfo } from '@stablyai/playwright-test'
import {
  execDockerSshRelayTargetCommand,
  type DockerSshRelayTarget,
  writeDockerSshRelayTargetFile
} from './helpers/docker-ssh-relay-target'

export const REMOTE_MONITOR_PATH = '/tmp/orca-idle-grid-monitor.mjs'
export const REMOTE_STATE_PATH = '/tmp/orca-idle-grid-state.json'

export type Grid = { cols: number; rows: number }

export type RemoteGridState = Grid & {
  draws: number
  pid: number
  updatedAt: number
  winches: number
}

export type RendererGridState = {
  applied: Grid | null
  xterm: Grid | null
}

export type ReproSample = {
  cycle: number
  elapsedMs: number
  remote: RemoteGridState
  renderer: RendererGridState
}

function idleGridMonitorScript(): string {
  return `
import fs from 'node:fs'

const statePath = process.argv[2]
let draws = 0
let winches = 0
let previousRow = null

function readGrid() {
  const [cols, rows] = process.stdout.getWindowSize()
  return { cols, rows }
}

function persist() {
  const grid = readGrid()
  const state = { ...grid, draws, pid: process.pid, updatedAt: Date.now(), winches }
  const temporaryPath = statePath + '.' + process.pid + '.tmp'
  fs.writeFileSync(temporaryPath, JSON.stringify(state))
  fs.renameSync(temporaryPath, statePath)
  return grid
}

function draw() {
  draws += 1
  const { cols, rows } = persist()
  const text = ('REMOTE_BOTTOM_BAR rows=' + rows + ' cols=' + cols + ' ' + '='.repeat(240)).slice(0, Math.max(1, cols - 1))
  const clearPrevious = previousRow && previousRow !== rows ? '\\x1b[' + previousRow + ';1H\\x1b[2K' : ''
  process.stdout.write('\\x1b7' + clearPrevious + '\\x1b[' + rows + ';1H\\x1b[2K' + text + '\\x1b8')
  previousRow = rows
}

process.on('SIGWINCH', () => {
  winches += 1
  draw()
})

draw()
setInterval(persist, 25)
setTimeout(() => process.exit(0), 600000)
`
}

export function installIdleGridMonitor(target: DockerSshRelayTarget): void {
  writeDockerSshRelayTargetFile(target, REMOTE_MONITOR_PATH, idleGridMonitorScript())
}

export function readRemoteGrid(target: DockerSshRelayTarget): RemoteGridState {
  const json = execDockerSshRelayTargetCommand(target, `cat ${REMOTE_STATE_PATH}`)
  return JSON.parse(json) as RemoteGridState
}

export async function readRendererGrid(page: Page, ptyId: string): Promise<RendererGridState> {
  return page.evaluate(async (id) => {
    let xterm: Grid | null = null
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes?.() ?? []) {
        if (pane.container?.dataset?.ptyId === id) {
          xterm = { cols: pane.terminal.cols, rows: pane.terminal.rows }
        }
      }
    }
    return {
      applied: (await window.api.pty.getSize(id)) ?? null,
      xterm
    }
  }, ptyId)
}

export function actualGridMatchesXterm(
  remote: RemoteGridState,
  renderer: RendererGridState
): boolean {
  return (
    renderer.xterm !== null &&
    renderer.xterm.cols > 0 &&
    renderer.xterm.rows > 0 &&
    remote.cols === renderer.xterm.cols &&
    remote.rows === renderer.xterm.rows
  )
}

export async function sampleRemoteConvergence(args: {
  cycle: number
  page: Page
  ptyId: string
  target: DockerSshRelayTarget
  timeoutMs?: number
}): Promise<{ last: ReproSample; stale: ReproSample[] }> {
  const startedAt = Date.now()
  const stale: ReproSample[] = []
  let last: ReproSample | null = null
  while (Date.now() - startedAt < (args.timeoutMs ?? 6_000)) {
    const remote = readRemoteGrid(args.target)
    const renderer = await readRendererGrid(args.page, args.ptyId)
    last = {
      cycle: args.cycle,
      elapsedMs: Date.now() - startedAt,
      remote,
      renderer
    }
    if (actualGridMatchesXterm(remote, renderer)) {
      return { last, stale }
    }
    stale.push(last)
    await args.page.waitForTimeout(100)
  }
  if (!last) {
    throw new Error('Remote grid convergence sampling produced no samples')
  }
  return { last, stale }
}

export async function attachStaleGridEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string,
  samples: ReproSample[]
): Promise<void> {
  await testInfo.attach(`${label}.json`, {
    body: Buffer.from(JSON.stringify(samples, null, 2)),
    contentType: 'application/json'
  })
  await testInfo.attach(`${label}.png`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png'
  })
}
