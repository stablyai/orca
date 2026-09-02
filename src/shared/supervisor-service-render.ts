/**
 * Renders the supervisor service definition for an orcad deployment.
 *
 * The whole reason this is generated rather than documented: orcad forks the terminal
 * daemon detached so PTYs outlive the runtime, and a supervisor that reaps the process
 * group destroys every running terminal on restart. `docs/reference/orcad-operations.md`
 * states that rule in prose, and every packaged path still gets it wrong — Homebrew's
 * generated systemd unit sets no `KillMode` at all, so systemd's `control-group` default
 * applies and `setsid` does not escape a cgroup.
 *
 * Pure by contract: config in, file text out, no I/O. The CLI, orcad itself and (later)
 * the SSH deploy path all consume these, and purity is what makes the invariants
 * assertable in a test rather than only on a host.
 */

/** launchd has no `KillMode`; it reaps the job's process group unless told not to. */
export type SupervisorPlatform = 'systemd' | 'launchd'

/** A user-scope service stops at logout unless lingering is enabled — see the audit. */
export type SupervisorScope = 'user' | 'system'

export type SupervisorServiceConfig = {
  platform: SupervisorPlatform
  scope: SupervisorScope
  /** Absolute path to the Node interpreter the supervisor should run, not the one that rendered this. */
  nodePath: string
  /** Absolute path to `orcad.js`. */
  orcadPath: string
  /**
   * Resolved at generation time; a unit inherits too little environment to resolve it
   * itself. Must be a realpath: `RequiresMountsFor` below cannot see through a symlink.
   */
  userDataPath: string
  /** Account the service runs as. Never root: orcad would create a root-owned data root. */
  user: string
  bind: string
  port: number
  /**
   * Only used by launchd, which cannot log to journald. Absolute, and resolved by the
   * caller: launchd expands no `~`, and the writable location depends on the scope. A
   * LaunchAgent runs unprivileged, so it cannot create `/var/log/orcad.log` — that path is
   * root-owned on macOS. Omitted rather than defaulted, because a plist naming a log the
   * job cannot open is worse than one naming none: launchd reports the failure against the
   * file, not against the job, so it reads as a broken install.
   */
  logPath?: string
}

export const ORCAD_LAUNCHD_LABEL = 'dev.onorca.orcad'
export const ORCAD_SYSTEMD_UNIT_NAME = 'orcad.service'

/**
 * Every value systemd's `KillMode` may take without reaping the detached daemon.
 *
 * `mixed` was here and is not safe. It SIGTERMs the main process and then SIGKILLs every
 * process still in the control group, which is where the detached daemon lives — the
 * escape it needs is from the cgroup, and setsid does not provide one. Measured on
 * systemd 219: a restart under mixed destroyed the daemon, its shell and its scrollback;
 * the identical unit under `process` kept all three. See `auditKillSemantics`, which now
 * names mixed specifically because orcad itself generated it.
 */
export const SAFE_SYSTEMD_KILL_MODES = ['process', 'none'] as const

/**
 * `none` spares the daemon but signals nothing at all, not even the main process, so the
 * runtime never gets its graceful stop and systemd deprecates it. Safe for this invariant,
 * wrong for everything else — the audit reports it rather than blessing it.
 */
export const DISCOURAGED_SYSTEMD_KILL_MODES = ['none'] as const

export class SupervisorServiceUnsupportedError extends Error {
  readonly code = 'supervisor_service_unsupported_platform'
  constructor(platform: NodeJS.Platform) {
    super(
      `Generating a service definition for ${platform} is not implemented. There is no ` +
        'systemd or launchd to target; a Windows Service needs its own launch and liveness ' +
        'contract, the same one that makes orcad remote deploy POSIX-only today.'
    )
    this.name = 'SupervisorServiceUnsupportedError'
  }
}

export function resolveSupervisorPlatform(platform: NodeJS.Platform): SupervisorPlatform {
  if (platform === 'darwin') {
    return 'launchd'
  }
  if (platform === 'linux') {
    return 'systemd'
  }
  throw new SupervisorServiceUnsupportedError(platform)
}

/**
 * `root` by name and `0` by number are one account. systemd's `User=` takes either spelling,
 * so a check that only knows the name renders exactly the unit it exists to refuse, and the
 * audit that only knows the name reads `User=0` back and reports `Runs as 0.` as healthy.
 * Both halves share this for that reason — the guard and the reader have to agree on what
 * root is, or the numeric spelling walks through the gap between them.
 */
export function isRootAccount(user: string): boolean {
  const account = user.trim()
  return account === 'root' || /^0+$/.test(account)
}

/**
 * Why refuse rather than render: a unit that runs orcad as root creates a root-owned data
 * root, and every later user-scope run then refuses with `orcad_data_root_wrong_owner` —
 * a state orcad deliberately will not repair, because the permissions are not its to fix.
 */
function assertNotRoot(user: string): void {
  if (isRootAccount(user)) {
    throw new Error(
      'refusing to generate a service that runs orcad as root: orcad would create a ' +
        'root-owned data root, and every later run as a normal user would then fail with ' +
        'orcad_data_root_wrong_owner. Pass the account orcad should run as.'
    )
  }
}

function orcadArgs(config: SupervisorServiceConfig): string[] {
  return [config.orcadPath, '--bind', config.bind, '--port', String(config.port), '--json']
}

/**
 * systemd splits every directive value below on whitespace, so an unquoted path containing a
 * space does not fail — it silently becomes something else. `Environment=` pins a truncated
 * root and the service comes up healthy and empty, which is the exact failure pinning the
 * root exists to prevent; `RequiresMountsFor=` takes a list, so the tail becomes extra paths
 * to order against; `ExecStart=` gains arguments nobody passed. launchd needs none of this:
 * every value there is its own `<string>` element.
 *
 * Quoted only when it has to be, so the common case stays a readable path in the file.
 * Inside double quotes systemd applies C-style escapes, so a backslash or quote in the value
 * has to survive one round of that.
 */
export function systemdQuote(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"` : value
}

function renderSystemd(config: SupervisorServiceConfig): string {
  const execStart = [config.nodePath, ...orcadArgs(config)].map(systemdQuote).join(' ')
  return `# Generated by orcad. Regenerate rather than hand-edit:
#   orcad --print-service --scope ${config.scope}
[Unit]
Description=Orca headless runtime (orcad)
After=network-online.target
# Orders this unit after whatever mount carries the data root. It only works on a
# fully-resolved path: systemd maps this to a mount unit textually, walking up parent
# directories, so a symlinked ancestor (DSM's /var/services/homes -> /volume2/homes,
# created during boot) resolves to the root filesystem and orders against nothing.
# The caller passes a realpath for exactly this reason.
RequiresMountsFor=${systemdQuote(config.userDataPath)}

[Service]
Type=simple
# No sd_notify: readiness is one JSON line on stdout, so TimeoutStartSec would gate
# nothing. It is omitted rather than set to a number that reads like a guarantee.

# Interpreter fixed at generation time; override with --node when the service should
# use a different one than the shell that generated this.
ExecStart=${execStart}
# A pinned --port still falls back to an OS-assigned port on conflict, so confirm the
# bound endpoint before relying on an SSH forward to it.

User=${config.user}
# Resolved at generation time. Without this the unit's near-empty environment resolves
# a different data root than your shell, and the service starts healthy and empty.
Environment=${systemdQuote(`ORCA_USER_DATA=${config.userDataPath}`)}

# The terminal daemon is forked detached so PTYs outlive the runtime. systemd's default
# control-group would reap it and make every restart destroy running work.
#
# process, not mixed. Measured on a Synology NAS running systemd 219: under mixed, a
# systemctl restart killed the daemon, its shell, the session and its scrollback. mixed
# SIGTERMs the main process and then SIGKILLs everything STILL IN THE CGROUP, and the
# daemon is in the cgroup -- setsid does not leave one. Only process signals the main
# process alone.
#
# The cost is real and accepted: systemd no longer reaps what the runtime leaves behind.
# orcad already owns that lifecycle through the daemon pid-record it adopts on the next
# start, and a supervisor that helpfully cleans up is exactly what breaks this.
KillMode=process

# 78 is EX_CONFIG — bad bind address, unusable or foreign data root. Restarting cannot
# fix it. A transient cause (an orcad you ran by hand) strands the unit here too; clear
# it with: systemctl reset-failed ${ORCAD_SYSTEMD_UNIT_NAME}
RestartPreventExitStatus=78
Restart=on-failure
RestartSec=5

# journald rather than a file: orcad rotates no logs of its own.
StandardOutput=journal
StandardError=journal

# No sandboxing directives, deliberately. orcad exists to run arbitrary user commands
# across arbitrary paths, and PrivateTmp in particular would give terminals a /tmp that
# nothing else on the host can see.

[Install]
WantedBy=${config.scope === 'user' ? 'default.target' : 'multi-user.target'}
`
}

/** Why escape: a data root or install path may contain `&` or `<`, which would break the plist. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderLaunchd(config: SupervisorServiceConfig): string {
  const args = [config.nodePath, ...orcadArgs(config)]
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n')
  // launchd has no journald equivalent, so this is a file and nothing rotates it — pair it
  // with a newsyslog.d entry. Emitted only when the caller resolved a path it knows the job
  // can write; see `logPath`.
  const logKeys = config.logPath
    ? `
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.logPath)}</string>
`
    : ''
  const scopeNote =
    config.scope === 'system'
      ? '     LaunchDaemon: runs at boot, independent of any login session.'
      : '     LaunchAgent: runs ONLY while this user is logged in. A headless Mac needs\n     scope system instead.'
  // Every flag below is NAMED rather than written with its leading dashes, and must stay
  // that way. XML forbids the string `--` anywhere inside a comment body, so writing
  // `--print-service` here makes the plist unparseable: expat rejects it, `plutil -lint`
  // rejects it, and launchctl refuses to load the job. The systemd renderer carries the
  // same sentence safely because `#` comments have no such rule, which is why this bites
  // on darwin only.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by orcad. Regenerate rather than hand-edit: run orcad with the
     print-service flag and scope ${config.scope}. The flags are named rather than
     written because XML forbids a double hyphen inside a comment.
${scopeNote} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ORCAD_LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${args}
  </array>

  <key>UserName</key>
  <string>${xmlEscape(config.user)}</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <!-- The terminal daemon is forked detached so PTYs outlive the runtime. Today it
       setsid()s clear of this process group anyway, so this key changes nothing —
       it is stated so the guarantee survives a change to how the daemon is forked. -->
  <key>AbandonProcessGroup</key>
  <true/>

  <!-- Resolved at generation time. launchd passes almost no environment through, and
       an unset root resolves somewhere else entirely. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORCA_USER_DATA</key>
    <string>${xmlEscape(config.userDataPath)}</string>
  </dict>
${logKeys}</dict>
</plist>
`
}

export function renderSupervisorService(config: SupervisorServiceConfig): string {
  assertNotRoot(config.user)
  return config.platform === 'systemd' ? renderSystemd(config) : renderLaunchd(config)
}

/** Where the rendered file goes, and what to run after placing it. */
export function supervisorInstallHint(config: SupervisorServiceConfig): {
  path: string
  commands: string[]
} {
  if (config.platform === 'launchd') {
    return config.scope === 'system'
      ? {
          path: `/Library/LaunchDaemons/${ORCAD_LAUNCHD_LABEL}.plist`,
          commands: [
            `sudo launchctl bootstrap system /Library/LaunchDaemons/${ORCAD_LAUNCHD_LABEL}.plist`
          ]
        }
      : {
          path: `~/Library/LaunchAgents/${ORCAD_LAUNCHD_LABEL}.plist`,
          commands: [
            `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${ORCAD_LAUNCHD_LABEL}.plist`
          ]
        }
  }
  return config.scope === 'system'
    ? {
        path: `/etc/systemd/system/${ORCAD_SYSTEMD_UNIT_NAME}`,
        // Why two commands and not `enable --now`: `--now` arrived in systemd 220, and the
        // hint is the operator's next action, so it may only name mechanisms that exist on
        // the host it is printed on. On systemd 219 (Synology DSM) the combined form fails
        // with `unrecognized option '--now'` — and because the whole command fails, the unit
        // is left installed but neither enabled nor started, which reads as a successful
        // install until the next reboot. `enable` then `start` works on every version.
        commands: [
          'sudo systemctl daemon-reload',
          `sudo systemctl enable ${ORCAD_SYSTEMD_UNIT_NAME}`,
          `sudo systemctl start ${ORCAD_SYSTEMD_UNIT_NAME}`
        ]
      }
    : {
        path: `~/.config/systemd/user/${ORCAD_SYSTEMD_UNIT_NAME}`,
        commands: [
          'systemctl --user daemon-reload',
          `systemctl --user enable ${ORCAD_SYSTEMD_UNIT_NAME}`,
          `systemctl --user start ${ORCAD_SYSTEMD_UNIT_NAME}`,
          // Without lingering the service dies with the SSH session that installed it.
          'sudo loginctl enable-linger "$USER"'
        ]
      }
}
