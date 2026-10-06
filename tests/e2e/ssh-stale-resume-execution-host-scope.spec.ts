/**
 * A provider session id names a transcript in ONE machine's agent state directory. Orca issued one
 * against the wrong machine and the agent answered
 * `No conversation found with session ID: <id>` in the user's remote terminal.
 *
 * Nothing in the resume path was host-scoped. `worktreeId` is `repoId::path` with no host component,
 * sleeping records merge across every host partition at boot without retaining which one they came
 * from, and the launch path resolves its target from the *current* catalog — so a record captured on
 * host A reaches a `--resume` executed on host B.
 *
 * This lane proves it at the only altitude that settles the question: the argv that actually lands
 * on the remote machine. Both tests restart the app across a relay kill (the shape of an Orca
 * update, which is what the user did) and read the stub agent's argv ledger out of the container.
 *
 *  - foreign stamp  → the ledger must hold no `--resume`, and the record must survive so the user
 *                     can still resume by hand. It must still hold Orca's ordinary `--version`
 *                     probe, or the lane would pass on an app that never reached the host at all.
 *  - matching stamp → the ledger must contain `--resume <id>`.
 *
 * The second is not a nicety. Without it the first passes on any app that resumes nothing at all,
 * which is exactly the failure mode a refuse-everything gate would ship.
 */
import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { killDockerSshRelayDaemon } from './helpers/docker-ssh-relay-faults'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  writeDockerSshRelayTargetFile,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

const SESSION_ID = 'e2e-stale-resume-87987465'
const ARGV_LEDGER = '/tmp/orca-e2e-claude-argv.log'
/** Stands in for a record the user carried over from another machine: its transcript is not on this
 *  host under this id. Any value that is not the connected target's works. */
const FOREIGN_CONNECTION_ID = 'orca-e2e-some-other-host'
/** Resolve the stamp to the connected target's own id, which is only minted during connect. */
const STAMP_OWNING_HOST = Symbol('stamp-owning-host')
/** How long a `--resume` gets to reach the host once the relaunched pane holds its PTY. The resume
 *  is typed into that very shell, so anything the gate let through lands well inside this. */
const RESUME_GRACE_MS = 20_000

test.use({ seedTestRepo: false })

/** A `claude` that records the argv it was invoked with and then holds the PTY open the way the real
 *  binary does. The ledger outlives the pane, and is appended to rather than truncated so a second
 *  invocation is visible as a second line. */
function installRemoteClaudeArgvLedger(target: DockerSshRelayTarget): void {
  writeDockerSshRelayTargetFile(
    target,
    '/usr/local/bin/claude',
    [
      '#!/bin/sh',
      `printf 'ARGV [%s] pid=%s ppid=%s %s\\n' "$(date +%s)" "$$" "$PPID" "$*" >> ${ARGV_LEDGER}`,
      'exec cat',
      ''
    ].join('\n')
  )
  execDockerSshRelayTargetCommand(target, 'chmod 755 /usr/local/bin/claude')
}

function readRemoteArgvLedger(target: DockerSshRelayTarget): string {
  return execDockerSshRelayTargetCommand(target, `cat ${ARGV_LEDGER} 2>/dev/null || true`).trim()
}

/** The lines appended since `baseline`. The ledger is append-only and the first launch already wrote
 *  its own `--version` probe to it, so "non-empty" says nothing about the relaunch — only the tail
 *  beyond what was there at quit does. Reading the whole ledger here is exactly the race that let the
 *  control case read two `--version` lines and give up before the resume was typed. */
function ledgerLinesSince(ledger: string, baseline: string): string {
  return ledger.startsWith(baseline) ? ledger.slice(baseline.length).trim() : ledger
}

/** Poll the relaunch's ledger lines until `until` holds or the budget runs out. Returns them either
 *  way: the negative case asserts on what did NOT arrive, so this must not throw. */
async function settleRemoteArgvLedger(
  target: DockerSshRelayTarget,
  baseline: string,
  budgetMs: number,
  until: (fresh: string) => boolean
): Promise<string> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const fresh = ledgerLinesSince(readRemoteArgvLedger(target), baseline)
    if (until(fresh) || Date.now() >= deadline) {
      return fresh
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

/**
 * One full incident replay: capture a sleeping agent record on the SSH worktree stamped with
 * `stamp`, quit, kill the relay so no PTY can be reclaimed (without that the pane's live PTY
 * suppresses the resume and the test proves nothing), relaunch, and report what reached the remote.
 */
async function resumeAcrossRestart(
  testInfo: TestInfo,
  target: DockerSshRelayTarget,
  stamp: string | typeof STAMP_OWNING_HOST,
  resumeBudgetMs: number
): Promise<{
  ledger: string
  recordSurvived: boolean
  diagnostics: {
    recordStamp: string
    entryStamp: string
    ledgerBeforeQuit: string
    ledgerAfterQuit: string
  }
}> {
  const restart = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const firstLaunch = await restart.launch()
    firstApp = firstLaunch.app
    await waitForSessionReady(firstLaunch.page)
    const remote = await connectDockerSshRelayTarget(firstLaunch.page, target)
    await expect
      .poll(() => waitForActiveWorktree(firstLaunch.page), { timeout: 60_000 })
      .toBe(remote.worktreeId)
    await waitForActiveTerminalManager(firstLaunch.page, 60_000)
    const descriptor = await waitForActivePaneHookDescriptor(firstLaunch.page, 60_000)

    // Why seeded rather than driven by a real agent: a real `claude` run needs an install and auth
    // in the container. This is the same store entry the hook server writes, so the capture,
    // persistence and resume paths under test are the production ones.
    await firstLaunch.page.evaluate(
      ({ paneKey, worktreeId, providerSessionId, connectionId }) => {
        window.__store?.getState().setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'finish the task', agentType: 'claude' },
          'Claude',
          undefined,
          { worktreeId, connectionId },
          {
            providerSession: { key: 'session_id', id: providerSessionId },
            launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} }
          }
        )
      },
      {
        paneKey: descriptor.paneKey,
        worktreeId: remote.worktreeId,
        providerSessionId: SESSION_ID,
        connectionId: stamp === STAMP_OWNING_HOST ? remote.targetId : stamp
      }
    )

    await firstLaunch.page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
    await expect
      .poll(
        () =>
          firstLaunch.page.evaluate(
            async ({ targetId, sessionId }) => {
              // The SSH worktree's rows live in the `ssh:<targetId>` partition, globals in `local`.
              const [local, host] = await Promise.all([
                window.api.session.get(),
                window.api.session.get(`ssh:${targetId}`)
              ])
              return [
                ...Object.values(local.sleepingAgentSessionsByPaneKey ?? {}),
                ...Object.values(host.sleepingAgentSessionsByPaneKey ?? {})
              ].some((record) => record.providerSession.id === sessionId)
            },
            { targetId: remote.targetId, sessionId: SESSION_ID }
          ),
        { timeout: 30_000, message: 'the sleeping agent record was never persisted before quit' }
      )
      .toBe(true)

    const ledgerBeforeQuit = readRemoteArgvLedger(target)

    await restart.close(firstApp)
    firstApp = null
    // The shape of an Orca update: the relay and every PTY under it are gone, so nothing is
    // reclaimable and the sleeping record is the only way the agent comes back.
    killDockerSshRelayDaemon(target)
    const ledgerAfterQuit = readRemoteArgvLedger(target)

    const secondLaunch = await restart.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page, 60_000)
    await expect
      .poll(() => waitForActiveWorktree(secondLaunch.page), { timeout: 90_000 })
      .toBe(remote.worktreeId)
    await waitForActiveTerminalManager(secondLaunch.page, 90_000)
    // The cold-restore decision is made before the replacement PTY is spawned, so a bound PTY
    // means the gate has already ruled on this record — after this, waiting is only for the
    // typed command to travel.
    await waitForActivePanePtyId(secondLaunch.page, 90_000)
    // Orca's per-launch `claude --version` probe proves the relaunch reached the host at all; the
    // negative case is vacuous without it.
    await settleRemoteArgvLedger(target, ledgerAfterQuit, 90_000, (fresh) =>
      fresh.includes('--version')
    )
    const ledger = await settleRemoteArgvLedger(target, ledgerAfterQuit, resumeBudgetMs, (fresh) =>
      fresh.includes('--resume')
    )
    // Why this is reported rather than merely asserted: the two host stamps are what the gate reads,
    // so a failure that does not name them cannot be told apart from the gate simply not running.
    const diagnostics = await secondLaunch.page.evaluate((sessionId) => {
      const state = window.__store?.getState()
      const record = Object.values(state?.sleepingAgentSessionsByPaneKey ?? {}).find(
        (candidate) => candidate.providerSession.id === sessionId
      )
      const entry = Object.values(state?.agentStatusByPaneKey ?? {}).find(
        (candidate) => candidate.providerSession?.id === sessionId
      )
      return {
        recordStamp: record ? String(record.connectionId) : 'no-record',
        entryStamp: entry ? String(entry.connectionId) : 'no-entry'
      }
    }, SESSION_ID)
    return {
      ledger,
      recordSurvived: diagnostics.recordStamp !== 'no-record',
      diagnostics: { ...diagnostics, ledgerBeforeQuit, ledgerAfterQuit }
    }
  } finally {
    if (secondApp) {
      await restart.close(secondApp)
    }
    if (firstApp) {
      await restart.close(firstApp)
    }
    await restart.dispose()
  }
}

test.describe('SSH sleeping-agent resume execution-host scope', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH tests use POSIX ssh tooling.')
  test.describe.configure({ mode: 'serial' })

  test("does not issue another host's session id against the SSH host", async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns both Electron launches.
  {}, testInfo) => {
    test.setTimeout(600_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      installRemoteClaudeArgvLedger(target)

      const result = await resumeAcrossRestart(
        testInfo,
        target,
        FOREIGN_CONNECTION_ID,
        RESUME_GRACE_MS
      )

      // Why not an empty ledger: Orca legitimately probes `claude --version` on the remote to
      // detect installed agents, once per launch. That is not a resume. The defect is `--resume`
      // carrying an id this machine never wrote, so that is what must be absent. `result.ledger`
      // is only what the relaunch appended, so the first launch's probe cannot satisfy this.
      expect(
        result.ledger,
        `Orca ran the agent on the SSH host with a session id captured on another machine.\nrecord stamp: ${result.diagnostics.recordStamp}\nlive entry stamp: ${result.diagnostics.entryStamp}\nledger before quit: ${JSON.stringify(result.diagnostics.ledgerBeforeQuit)}\nledger after quit+relay kill: ${JSON.stringify(result.diagnostics.ledgerAfterQuit)}`
      ).not.toContain('--resume')
      expect(result.ledger).not.toContain(SESSION_ID)
      // The relaunch's lines must not be empty either, or this proves only that the agent never
      // ran at all.
      expect(
        result.ledger,
        'the stub agent was never invoked by the relaunch, so the lane proves nothing'
      ).toContain('--version')
      // Declining is only recoverable if the record survives; deleting it on a host disagreement
      // would destroy the user's only handle on that transcript.
      expect(result.recordSurvived, 'the declined record was discarded, not preserved').toBe(true)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('still resumes a session captured on the SSH host that owns the workspace', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns both Electron launches.
  {}, testInfo) => {
    test.setTimeout(600_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      installRemoteClaudeArgvLedger(target)

      // The control for the test above: the same machinery, one field different, and the resume
      // must still land on the remote.
      const result = await resumeAcrossRestart(testInfo, target, STAMP_OWNING_HOST, 90_000)

      expect(result.ledger, 'the legitimate resume never reached the SSH host').toContain(
        `--resume ${SESSION_ID}`
      )
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
