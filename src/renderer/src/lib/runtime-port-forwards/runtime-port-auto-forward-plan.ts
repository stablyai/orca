import type { WorkspacePort } from '../../../../shared/workspace/ports/workspace-ports'
import {
  RUNTIME_PORT_FORWARD_AUTO_EXCLUDED_PORTS,
  type RuntimePortForward,
  type RuntimePortForwardSettings
} from '../../../../shared/runtime-port-forwards'

// A listener must be missing from this many scans in a row before its auto forward closes.
export const AUTO_FORWARD_MISSING_SCANS_BEFORE_CLOSE = 2

export type AutoForwardPlan = {
  open: WorkspacePort[]
  close: RuntimePortForward[]
  /** Remote ports seen in this scan, for the next scan's missing counts. */
  missing: Map<number, number>
}

/**
 * Agent CLIs open their own listeners (Codex's sign-in callback and app server, Claude's IDE and MCP
 * bridges). Those are the agent's plumbing, not the user's app: never auto-forwarded or announced.
 */
const AGENT_CLI_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'opencode',
  'opencode2',
  'gemini',
  'cursor-agent',
  'grok',
  'omp',
  'pi',
  'amp',
  'goose',
  'droid',
  'qwen',
  'copilot',
  'aider'
])

/** The start of the OS ephemeral range (Linux's default; macOS and Windows start higher, at 49152). */
export const EPHEMERAL_PORT_START = 32_768

/** `codex`, `/usr/bin/codex`, `codex.exe` and `codex-linux-x64` all name Codex. */
export function isAgentCliProcessName(processName: string | undefined): boolean {
  if (!processName) {
    return false
  }
  const base = (processName.trim().toLowerCase().split(/[\\/]/).at(-1) ?? '').replace(/\.exe$/, '')
  return (
    AGENT_CLI_PROCESS_NAMES.has(base) ||
    [...AGENT_CLI_PROCESS_NAMES].some((name) => base.startsWith(`${name}-`))
  )
}

/**
 * Looks like a dev server: a well-known web port, or a URL the workspace printed for it. A listener
 * on an ephemeral port with neither is some process's internal socket (an agent's MCP child, a
 * language server, a debugger), so it isn't forwarded on its own.
 */
function looksLikeDevServer(port: Extract<WorkspacePort, { kind: 'workspace' }>): boolean {
  return port.port < EPHEMERAL_PORT_START || port.protocol !== 'unknown' || !!port.advertisedUrl
}

/**
 * Dev servers a workspace started: attributed to a workspace, in range, not Orca's own, not an
 * agent CLI's own listener, and not an anonymous ephemeral port.
 */
export function isAutoForwardCandidate(
  port: WorkspacePort,
  settings: RuntimePortForwardSettings
): boolean {
  return (
    port.kind === 'workspace' &&
    port.port >= settings.rangeStart &&
    port.port <= settings.rangeEnd &&
    !RUNTIME_PORT_FORWARD_AUTO_EXCLUDED_PORTS.has(port.port) &&
    !isAgentCliProcessName(port.processName) &&
    looksLikeDevServer(port)
  )
}

/**
 * Decides which listeners of one host to forward and which auto forwards to retire. `attempted`
 * holds ports already tried this session (opened, refused or closed by the user) so they are not retried.
 */
export function planAutoForwards(args: {
  ports: readonly WorkspacePort[]
  forwards: readonly RuntimePortForward[]
  settings: RuntimePortForwardSettings
  attempted: ReadonlySet<number>
  previousMissing: ReadonlyMap<number, number>
}): AutoForwardPlan {
  const { ports, forwards, settings, attempted, previousMissing } = args
  const listening = new Set(ports.map((port) => port.port))
  const candidates = new Set(
    ports.filter((port) => isAutoForwardCandidate(port, settings)).map((port) => port.port)
  )
  const forwarded = new Set(forwards.map((forward) => forward.remotePort))
  const open = settings.autoForward
    ? dedupeByPort(
        ports.filter(
          (port) =>
            isAutoForwardCandidate(port, settings) &&
            !forwarded.has(port.port) &&
            !attempted.has(port.port)
        )
      )
    : []
  const missing = new Map<number, number>()
  const close: RuntimePortForward[] = []
  for (const forward of forwards) {
    // Retire when the server is gone, or when it is no longer a candidate (e.g. Orca's own listener) and idle.
    const keep =
      candidates.has(forward.remotePort) ||
      (listening.has(forward.remotePort) &&
        forward.openConnections > 0 &&
        !RUNTIME_PORT_FORWARD_AUTO_EXCLUDED_PORTS.has(forward.remotePort))
    if (forward.reason !== 'auto' || keep) {
      continue
    }
    const count = (previousMissing.get(forward.remotePort) ?? 0) + 1
    if (count >= AUTO_FORWARD_MISSING_SCANS_BEFORE_CLOSE) {
      close.push(forward)
    } else {
      missing.set(forward.remotePort, count)
    }
  }
  return { open, close, missing }
}

// IPv4 and IPv6 binds of one server are two rows for the same port.
function dedupeByPort(ports: WorkspacePort[]): WorkspacePort[] {
  const seen = new Set<number>()
  return ports.filter((port) => {
    if (seen.has(port.port)) {
      return false
    }
    seen.add(port.port)
    return true
  })
}
