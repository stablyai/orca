export const TERMINAL_UNAVAILABLE_ERROR_CODE = 'terminal_unavailable' as const

export const TERMINAL_PTY_DEGRADATION_CAPABILITY = 'terminal.pty.v1' as const

export type RuntimeBrowserUnavailableReason =
  | 'unconfigured'
  | 'driver_missing'
  | 'executable_not_found'
  | 'executable_not_executable'
  | 'electron_start_failed'
  | 'chromium_start_failed'
  | 'provider_unhealthy'
  | 'desktop_window_unavailable'
  | 'unknown'

/**
 * Why this host cannot spawn PTYs. Members are opaque to clients: render `message`,
 * never switch exhaustively. Dynamic-loader failures are proved out of process because
 * an incompatible native binary can terminate the host before JavaScript can catch it.
 */
export type RuntimeTerminalUnavailableReason =
  | 'dependency_missing'
  | 'toolchain_missing'
  | 'libc_floor'
  | 'shared_library_missing'
  | 'abi_mismatch'
  | 'arch_mismatch'
  | 'load_failed'
  | 'load_crashed'
  | 'spawn_helper_missing'
  | 'unknown'

export type RuntimeDegradation = {
  /**
   * Open vocabulary. New codes ship without a protocol bump, so clients must render
   * `message` and must not switch exhaustively on this or the `reason` field.
   */
  code: 'browser_unavailable' | typeof TERMINAL_UNAVAILABLE_ERROR_CODE
  capability: 'browser.headless.v1' | typeof TERMINAL_PTY_DEGRADATION_CAPABILITY
  message: string
  reason?: RuntimeBrowserUnavailableReason | RuntimeTerminalUnavailableReason
  /** Underlying error text when the host has one. Diagnostic only; never load-bearing. */
  detail?: string
}

const TERMINAL_UNAVAILABLE_MESSAGES: Record<RuntimeTerminalUnavailableReason, string> = {
  dependency_missing:
    'Terminals are unavailable on this host: node-pty has no native binary for this platform. Install or rebuild it, or deploy a build that ships a prebuilt binary for this platform.',
  toolchain_missing:
    'Terminals are unavailable on this host: node-pty has no prebuilt binary for Linux and this host is missing the C/C++ build tools needed to compile one. Install them, then reconnect.',
  libc_floor:
    "This host's node-pty binary was built against a newer C library than the host provides, so the dynamic loader refuses it. Rebuild node-pty on this host, or deploy a build whose prebuilt binary matches this platform's libc.",
  shared_library_missing:
    'Terminals are unavailable on this host: a shared library that node-pty links against is not installed, so the dynamic loader cannot open the binary. Install the named library, then reconnect.',
  abi_mismatch:
    "This host's node-pty binary was built for a different Node ABI than the running Node, so it cannot be loaded. Rebuild node-pty against this Node version.",
  arch_mismatch:
    "This host's node-pty binary was built for a different CPU architecture than the running Node, so the dynamic loader refuses it. Rebuild node-pty on this host, or deploy a build for this architecture.",
  load_failed: 'Terminals are unavailable on this host: node-pty failed to load.',
  load_crashed:
    'Terminals are unavailable on this host: loading node-pty terminated the probe process, which means the binary is incompatible with this host rather than merely missing.',
  spawn_helper_missing:
    'node-pty loaded, but its spawn-helper executable is missing or not executable, so every terminal spawn would fail. Reinstall node-pty on this host.',
  unknown: 'Terminals are unavailable on this host, and the cause could not be determined.'
}

export function terminalUnavailableMessage(
  reason: RuntimeTerminalUnavailableReason,
  detail?: string
): string {
  const base = TERMINAL_UNAVAILABLE_MESSAGES[reason]
  return detail ? `${base} (${detail})` : base
}
