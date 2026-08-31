import type { WorktreeSetupLaunch } from './worktree/launch-types'
import {
  SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from './setup-agent-sequencing-env'
import {
  buildPosixSetupCommand,
  buildPosixSetupScript,
  buildPosixStartupScript
} from './setup-agent-sequencing-posix-gate'
import {
  buildWindowsSetupCommand,
  buildWindowsStartupCommand
} from './setup-agent-sequencing-windows-gate'
import {
  nativeWindowsPathToPosixShellPath,
  resolveSetupRunnerCommand,
  type SetupRunnerCommandPlatform,
  type SetupRunnerCommandShell,
  type SetupRunnerShell
} from './setup-runner-command'

// Why: a cold monorepo install plus a native rebuild is the slowest legitimate setup we ship
// against, and that lands in single-digit minutes even on a slow link. 30 minutes leaves several
// times that headroom while still telling the user something is wrong inside one sitting; the
// two-hour bound this replaced was indistinguishable from a hang. Progress ticks below are the
// primary signal — this is only the backstop.
const DEFAULT_WAIT_TIMEOUT_SECONDS = 30 * 60
// Why: the setup terminal is spawned in the same host operation as the agent terminal and writes
// its start sentinel before running a single line of the script, so anything past a slow shell
// profile plus an SSH round trip means nobody is going to run setup at all. Expiring fails closed
// with a clear retry message; an unknown setup outcome must never authorize an agent launch.
const SETUP_START_GRACE_SECONDS = 45
// Why: a silent terminal reads as a hang, so the wait reports itself on a human interval.
const WAIT_PROGRESS_INTERVAL_SECONDS = 15

export {
  SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from './setup-agent-sequencing-env'

export type SequencedSetupAgentCommands = {
  setupCommand: string
  /** Must be merged into the setup terminal's env; without it `setupCommand` degrades to the
   *  bare runner and the gate below reports setup as never-started instead of hanging. */
  setupEnv?: Record<string, string>
  startupCommand: string
  startupEnv?: Record<string, string>
}

/** Folds a sequenced pair's setup half into the launch record every setup launcher already
 *  consumes. Keeping the gated command and the env that feeds it in one object is what makes the
 *  pairing structural: a launcher cannot pick up `command` while dropping `setupEnv`, and both
 *  fields already cross the client/host wire, so no new field is introduced. */
export function applySequencedSetupLaunch(
  setup: WorktreeSetupLaunch,
  sequenced: SequencedSetupAgentCommands
): WorktreeSetupLaunch {
  return {
    ...setup,
    command: sequenced.setupCommand,
    envVars: { ...setup.envVars, ...sequenced.setupEnv }
  }
}

export function resolveSetupAgentSequenceLaunchCommand(
  env: Record<string, string | undefined>,
  fallbackCommand: string | undefined
): string | undefined {
  const sequencedStartup = env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]?.trim()
  return sequencedStartup || fallbackCommand
}

export function createSetupAgentSequenceNonce(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function createSequencedSetupAgentCommands(args: {
  runnerScriptPath: string
  startupCommand: string
  platform: SetupRunnerCommandPlatform
  shell?: SetupRunnerShell
  nonce?: string
  waitTimeoutSeconds?: number
  startGraceSeconds?: number
  progressIntervalSeconds?: number
}): SequencedSetupAgentCommands {
  const nonce = args.nonce ?? createSetupAgentSequenceNonce()
  const resolution = resolveSetupRunnerCommand(args.runnerScriptPath, args.platform, args.shell)
  // Why: the gate is typed into the terminal pane and `startupCommand` is already quoted for that
  // pane, so a batch runner launched from a Git Bash pane still needs the bash gate — PowerShell's
  // `Invoke-Expression` cannot parse the POSIX `'\''` escaping the pane's quoting produces. The
  // runner itself still launches through `resolution.command`, never through bash.
  const posixGateForWindowsRunner = resolution.shell === 'windows' && args.shell?.family === 'posix'
  const markerBasePath = posixGateForWindowsRunner
    ? nativeWindowsPathToPosixShellPath(resolution.runnerScriptPathForShell)
    : resolution.runnerScriptPathForShell
  // Why: overlapping gated launches of the same setup runner must not race on
  // a shared completion marker.
  const markerPath = `${markerBasePath}.${nonce}.done`
  const waitTimeoutSeconds = args.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS
  const startGraceSeconds = args.startGraceSeconds ?? SETUP_START_GRACE_SECONDS
  const progressIntervalSeconds = args.progressIntervalSeconds ?? WAIT_PROGRESS_INTERVAL_SECONDS

  if (resolution.shell === 'windows' && !posixGateForWindowsRunner) {
    return {
      setupCommand: buildWindowsSetupCommand(
        resolution.runnerScriptPathForShell,
        markerPath,
        nonce
      ),
      startupCommand: buildWindowsStartupCommand(
        markerPath,
        nonce,
        waitTimeoutSeconds,
        startGraceSeconds,
        progressIntervalSeconds
      ),
      startupEnv: {
        [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.startupCommand
      }
    }
  }

  const startupScript = buildPosixStartupScript(
    args.startupCommand,
    markerPath,
    nonce,
    waitTimeoutSeconds,
    startGraceSeconds,
    progressIntervalSeconds
  )
  return {
    // Why: the wrapper embeds the runner path three times plus the nonce, which for an ordinary
    // worktree exceeds the 1024-byte canonical input cap a PTY applies before the shell's line
    // editor takes over — the submit byte is dropped and setup never records an outcome. Same
    // env-var indirection the startup gate already uses; the inline branch keeps a launcher that
    // forgets `setupEnv` running the bare runner instead of nothing.
    setupCommand: buildPosixSetupCommand(resolution.command),
    setupEnv: {
      [SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]: buildPosixSetupScript(
        resolution.command,
        markerPath,
        nonce
      )
    },
    // Why: long worktree paths can push the gate past a PTY's canonical input cap and drop its submit byte.
    startupCommand: `bash -lc 'eval "$${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}"'`,
    startupEnv: {
      [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.startupCommand,
      [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: startupScript
    }
  }
}

export function getSetupAgentSequenceShellForTests(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform
): SetupRunnerCommandShell {
  return resolveSetupRunnerCommand(runnerScriptPath, platform).shell
}
