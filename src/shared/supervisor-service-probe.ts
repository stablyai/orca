/**
 * Gathers live evidence about an installed orcad service.
 *
 * The whole point of the split: a probe never produces a finding, only an observation.
 * `auditSupervisorServices` stays pure and stays assertable against fixtures, and no probe
 * can smuggle a verdict past it. Anything a probe cannot establish comes back
 * `unavailable` with a reason — never as a negative, because a refused, missing or
 * timed-out probe is not evidence that a service is stopped.
 */
import { createConnection } from 'node:net'
import { runProcess } from './child-process/run-process'
import type { SupervisorPlatform, SupervisorScope } from './supervisor-service-render'

/** Bounded well under runProcess's 30s default: a doctor that hangs is one nobody re-runs. */
const PROBE_TIMEOUT_MS = 5_000
const PORT_PROBE_TIMEOUT_MS = 1_500

export type Probe<T> =
  | { status: 'observed'; value: T }
  /** Shown to the operator: "unverified" with no cause reads as a broken tool. */
  | { status: 'unavailable'; reason: string }

export type UnitState = {
  /**
   * Whether the supervisor knows about the unit at all. Load-bearing because
   * `systemctl show` exits 0 for a unit it has never heard of and reports
   * `ActiveState=inactive` — indistinguishable from a service someone stopped, and the
   * likeliest state in a workflow that prints a file for an operator to place by hand.
   */
  load: string
  active: string
  sub: string
  result: string
  restarts: number
}

export type ExecTargetState = {
  interpreter: string
  interpreterExists: boolean
  script: string | null
  scriptExists: boolean
}

export type JournalState = {
  /** journald's `Storage=`. `volatile` means the journal lives in /run and dies on reboot. */
  storage: string
  /** Only meaningful when the audited unit actually logs to the journal. */
  unitUsesJournal: boolean
}

export type SupervisorEvidence = {
  unitState?: Probe<UnitState>
  linger?: Probe<boolean>
  /** A listener on the configured port. Not proof it is orcad — see the audit's wording. */
  configuredPortListening?: Probe<boolean>
  /** A stat, not a subprocess, so `--no-probe` does not suppress it. */
  execTarget?: Probe<ExecTargetState>
  /** Read from journald.conf, likewise a file read rather than a probe. */
  journal?: Probe<JournalState>
  /**
   * Whether the pinned data root and the caller's resolve to the same directory. A string
   * comparison cannot answer this: once the generator started pinning a realpath, a host
   * whose root sits behind a symlink reports two spellings of one directory.
   */
  dataRootSameDirectory?: Probe<boolean>
}

/** What to ask about, derived from the file discovery rather than from a constant. */
export type ProbeTarget = {
  platform: SupervisorPlatform
  scope: SupervisorScope
  /** Unit filename or launchd label, taken from the discovered file's own basename. */
  name: string
  user: string
  bind: string
  port: number
}

function unavailable(reason: string): Probe<never> {
  return { status: 'unavailable', reason }
}

/**
 * Every failure mode of a probe collapses to one shape here. A timeout, a missing binary
 * and a permission refusal are all "could not establish", and the reason carries which.
 */
async function capture(
  program: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await runProcess({ program, args, timeoutMs })
    if (result.timedOut) {
      return { ok: false, reason: `${program} did not respond within ${timeoutMs}ms` }
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n')[0]
      return {
        ok: false,
        reason: detail ? `${program}: ${detail}` : `${program} exited ${result.code}`
      }
    }
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    return {
      ok: false,
      reason: `${program} could not be run: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** `KEY=value` lines, as `systemctl show` and `loginctl show-user` both emit. */
function parseShowOutput(stdout: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
    }
  }
  return values
}

async function probeSystemdUnit(target: ProbeTarget): Promise<Probe<UnitState>> {
  const scopeArgs = target.scope === 'user' ? ['--user'] : []
  const captured = await capture('systemctl', [
    ...scopeArgs,
    'show',
    target.name,
    '--property=LoadState,ActiveState,SubState,Result,NRestarts'
  ])
  if (!captured.ok) {
    // A user-scope query without a session bus fails exactly like an absent unit, so the
    // reason has to travel with the verdict rather than be flattened into "not running".
    return unavailable(captured.reason)
  }
  const values = parseShowOutput(captured.stdout)
  const active = values.get('ActiveState')
  if (!active) {
    return unavailable('systemctl returned no ActiveState')
  }
  return {
    status: 'observed',
    value: {
      load: values.get('LoadState') ?? 'unknown',
      active,
      sub: values.get('SubState') ?? 'unknown',
      result: values.get('Result') ?? 'unknown',
      restarts: Number(values.get('NRestarts') ?? '0') || 0
    }
  }
}

async function probeLaunchdJob(target: ProbeTarget): Promise<Probe<UnitState>> {
  const uid = process.getuid?.()
  if (target.scope === 'user' && uid === undefined) {
    // `gui/` with no uid is not a domain launchctl accepts; asking anyway would return a
    // parse error that reads like the job being absent.
    return unavailable('cannot address the gui domain: this platform reports no uid')
  }
  const domain = target.scope === 'system' ? 'system' : `gui/${uid}`
  const captured = await capture('launchctl', ['print', `${domain}/${target.name}`])
  if (!captured.ok) {
    // The system domain refuses without root; that is inability, not absence.
    return unavailable(captured.reason)
  }
  const state = /\bstate\s*=\s*(\w+)/.exec(captured.stdout)?.[1]
  if (!state) {
    return unavailable('launchctl print returned no state')
  }
  return {
    status: 'observed',
    value: {
      // launchctl print answering at all means the job is loaded.
      load: 'loaded',
      active: state === 'running' ? 'active' : state,
      sub: state,
      result: /\blast exit code\s*=\s*(\d+)/.exec(captured.stdout)?.[1] ?? 'unknown',
      restarts: 0
    }
  }
}

/** Only systemd has lingering; launchd's equivalent question is Agent-versus-Daemon. */
async function probeLinger(target: ProbeTarget): Promise<Probe<boolean> | undefined> {
  if (target.platform !== 'systemd' || target.scope !== 'user') {
    return undefined
  }
  const captured = await capture('loginctl', ['show-user', target.user, '--property=Linger'])
  if (!captured.ok) {
    return unavailable(captured.reason)
  }
  const linger = parseShowOutput(captured.stdout).get('Linger')
  return linger === undefined
    ? unavailable('loginctl returned no Linger property')
    : { status: 'observed', value: linger === 'yes' }
}

/**
 * Why a TCP connect and not the readiness line from the journal: reading the journal needs
 * group membership, can be rotated away, and returns nothing from a service that has not
 * logged recently. A connect answers the question that matters — is anything serving where
 * the file says it should be — with no privilege and nothing to parse.
 */
export function probePort(host: string, port: number): Promise<Probe<boolean>> {
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return new Promise((resolve) => {
    const socket = createConnection({ host: target, port })
    const settle = (probe: Probe<boolean>): void => {
      socket.destroy()
      resolve(probe)
    }
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS)
    socket.once('connect', () => settle({ status: 'observed', value: true }))
    socket.once('timeout', () =>
      settle(unavailable(`no answer from ${target}:${port} within ${PORT_PROBE_TIMEOUT_MS}ms`))
    )
    socket.once('error', (error: NodeJS.ErrnoException) => {
      // Only a refused connection proves nothing is listening. Anything else — no route,
      // a firewall, an exhausted fd table — is inability to tell.
      settle(
        error.code === 'ECONNREFUSED'
          ? { status: 'observed', value: false }
          : unavailable(`${target}:${port}: ${error.code ?? error.message}`)
      )
    })
  })
}

export async function gatherSupervisorEvidence(target: ProbeTarget): Promise<SupervisorEvidence> {
  const [unitState, linger, configuredPortListening] = await Promise.all([
    target.platform === 'systemd' ? probeSystemdUnit(target) : probeLaunchdJob(target),
    probeLinger(target),
    probePort(target.bind, target.port)
  ])
  return { unitState, linger, configuredPortListening }
}
