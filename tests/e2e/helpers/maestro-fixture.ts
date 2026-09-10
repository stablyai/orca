import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

export type MaestroDetailKind = 'task' | 'attempt' | 'finding' | 'cleanup'

type MaestroTaskFixture = {
  id: string
  attemptIds: string[]
  outcome: 'active' | 'approved' | 'blocked'
  progress: number
  findingId?: string
  findingClassification?: 'nonblocking_hardening' | 'blocking'
  acceptanceReference?: string
}

const tasks: MaestroTaskFixture[] = [
  {
    id: 'ORC-09',
    attemptIds: ['attempt-orc-09-002'],
    outcome: 'active',
    progress: 62
  },
  {
    id: 'ORC-10',
    attemptIds: ['attempt-orc-10-001'],
    outcome: 'approved',
    progress: 86,
    findingId: 'finding-orc10-hardening',
    findingClassification: 'nonblocking_hardening'
  },
  {
    id: 'ORC-11',
    attemptIds: ['attempt-orc-11-001', 'attempt-orc-11-002'],
    outcome: 'blocked',
    progress: 74,
    findingId: 'finding-orc11-browser-cleanup',
    findingClassification: 'blocking',
    acceptanceReference: 'ORC-11 browser release acceptance'
  }
]

const details: Record<MaestroDetailKind, Record<string, string>> = {
  task: Object.fromEntries(tasks.map((task) => [task.id, `task:${task.id}`])),
  attempt: Object.fromEntries(
    tasks.flatMap((task) => task.attemptIds.map((attemptId) => [attemptId, `attempt:${attemptId}`]))
  ),
  finding: Object.fromEntries(
    tasks.flatMap((task) => (task.findingId ? [[task.findingId, `finding:${task.findingId}`]] : []))
  ),
  cleanup: {
    'cleanup-tracked-workers': 'cleanup:tracked-workers',
    'cleanup-browser-surface': 'cleanup:browser-surface'
  }
}

export const maestroJournalFixture = {
  revision: 47,
  navigatorDigestRevision: 47,
  cardDigestRevision: 47,
  tasks,
  reductions: [
    { mode: 'single_writer', workers: 1, receipt: 'resource-pressure-receipt-01' },
    { mode: 'parallel', workers: 2, receipt: 'evidence-backed-parallel-receipt-02' }
  ],
  serialTerminal: {
    terminalId: 'terminal-tracked-serial',
    taskIds: ['ORC-09', 'ORC-10', 'ORC-11'],
    capsuleIds: ['attempt-orc-09-002', 'attempt-orc-10-001', 'attempt-orc-11-001'],
    checkIds: ['check-orc09', 'check-orc10', 'check-orc11'],
    gradeIds: ['grade-orc09', 'grade-orc10', 'grade-orc11']
  },
  incompatibleTerminal: { terminalId: 'terminal-fresh-profile', resumed: false },
  browser: {
    visible: {
      surfaceId: 'browser-surface-visible',
      ownership: 'harness',
      requestedVisibility: 'visible',
      observedVisibility: 'visible',
      pane: 'Browser',
      evidenceArtifact: 'artifact:maestro-browser-evidence/sha256/orc11-visible.png',
      visionReceipt: 'vision:orc11-visible',
      release: 'released'
    },
    offscreen: {
      surfaceId: 'browser-surface-offscreen',
      requestedVisibility: 'offscreen',
      observedVisibility: 'offscreen',
      countsAsVisibleProof: false
    },
    userOwnedNeighbor: { pageId: 'user-browser-page', affectedByRelease: false }
  },
  cleanup: {
    trackedWorkersReleased: true,
    coordinatorReleased: true,
    looseUserTerminal: {
      terminalId: 'terminal-user-loose',
      connected: true,
      writable: true,
      presentInCleanupReceipts: false
    },
    processDescendantsExited: true,
    worktreeListingIsObservationOnly: true
  },
  diagnostics: {
    coordinationDurationMs: 4210,
    dispatches: 3,
    operationalFailures: 1,
    technicalAttempts: 2,
    optionalTokenCount: 1200,
    optionalCacheHit: true
  },
  launchReceipts: [
    { agent: 'codex', args: ['--yolo'], model: 'gpt-5.6-terra', effort: 'high' },
    {
      agent: 'claude',
      args: ['--dangerously-skip-permissions'],
      model: 'claude-sonnet',
      effort: 'high'
    }
  ]
} as const

export function resolveMaestroDetail(kind: MaestroDetailKind, id: string): string | undefined {
  return details[kind][id]
}

export function hasConsistentDigestRevision(): boolean {
  return (
    maestroJournalFixture.revision === maestroJournalFixture.navigatorDigestRevision &&
    maestroJournalFixture.revision === maestroJournalFixture.cardDigestRevision
  )
}

export function hasValidCarryForwardState(): boolean {
  const carried = maestroJournalFixture.tasks.find((task) => task.id === 'ORC-10')
  return Boolean(
    carried &&
    carried.outcome === 'approved' &&
    carried.progress < 100 &&
    carried.findingClassification === 'nonblocking_hardening'
  )
}

export function hasNoUndecidedThirdTechnicalAttempt(): boolean {
  const blocked = maestroJournalFixture.tasks.find((task) => task.id === 'ORC-11')
  return Boolean(blocked && blocked.attemptIds.length === 2 && blocked.acceptanceReference)
}

const evidenceRoot = resolve(process.cwd(), '.visual-evidence/maestro-worktree-canvas')

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = (open: boolean) => {
      socket.destroy()
      resolveOpen(open)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(300, () => done(false))
  })
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await portOpen(port)) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for port ${port}`)
}

function descendantProcessTree(rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>()
  for (const line of execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    childrenByParent.set(parentPid, [...(childrenByParent.get(parentPid) ?? []), pid])
  }
  const descendants: number[] = []
  const visit = (parentPid: number): void => {
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      visit(childPid)
      descendants.push(childPid)
    }
  }
  visit(rootPid)
  return [...descendants, rootPid]
}

function signalProcessTree(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // The process exited between discovery and the signal.
    }
  }
}

function processTreeExited(pids: readonly number[]): boolean {
  return pids.every((pid) => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  })
}

async function stopProcessGroup(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null) {
    return
  }
  const ownedPids = descendantProcessTree(child.pid)
  signalProcessTree(ownedPids, 'SIGTERM')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (processTreeExited(ownedPids)) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  signalProcessTree(ownedPids, 'SIGKILL')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (processTreeExited(ownedPids)) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  if (!processTreeExited(ownedPids)) {
    throw new Error(`Native Maestro fixture left owned processes: ${ownedPids.join(',')}`)
  }
}

async function awaitBrowserDisconnect(browser: Browser | undefined): Promise<void> {
  if (!browser) {
    return
  }
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolveDeadline) => setTimeout(resolveDeadline, 2_000))
  ])
}

export async function launchNativeMaestroFixture(): Promise<{
  page: Page
  close: () => Promise<void>
}> {
  const env = { ...process.env }
  delete env.ORCA_E2E_HEADLESS
  delete env.ELECTRON_RUN_AS_NODE
  let vite: ChildProcess | undefined
  let electron: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    if ((await portOpen(41739)) || (await portOpen(9341))) {
      throw new Error('Native Maestro fixture requires clean ports 41739 and 9341')
    }
    vite = spawn('pnpm', ['exec', 'vite', '--config', resolve(evidenceRoot, 'vite.config.ts')], {
      cwd: process.cwd(),
      detached: true,
      env,
      stdio: 'ignore'
    })
    await waitForPort(41739)
    electron = spawn(
      'pnpm',
      [
        'exec',
        'electron',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=9341',
        resolve(evidenceRoot, 'electron-bootstrap-orc11.cjs')
      ],
      { cwd: process.cwd(), detached: true, env, stdio: 'ignore' }
    )
    await waitForPort(9341)
    browser = await chromium.connectOverCDP('http://127.0.0.1:9341')
    const page = browser.contexts()[0]?.pages()[0]
    if (!page) {
      throw new Error('Native Electron fixture did not create a page')
    }
    return {
      page,
      close: async () => {
        await Promise.all([stopProcessGroup(electron), stopProcessGroup(vite)])
        await awaitBrowserDisconnect(browser)
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (!(await portOpen(41739)) && !(await portOpen(9341))) {
            return
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 100))
        }
        throw new Error('Native Electron fixture left a capture listener open')
      }
    }
  } catch (error) {
    await Promise.all([stopProcessGroup(electron), stopProcessGroup(vite)])
    await awaitBrowserDisconnect(browser)
    throw error
  }
}
