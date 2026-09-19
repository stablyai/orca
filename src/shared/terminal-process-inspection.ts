import type { RemoteForegroundEvidence } from './foreground-process-evidence'

/**
 * What the execution host observed about processes running under a PTY's shell.
 *
 * Separate from `hasChildProcesses` because a boolean cannot hold the third answer. The host that
 * could not read its own process table and the host that read it and found nothing both had to
 * spell themselves `false`, and every close guard reads `false` as "nothing is running here".
 * Windows relays spelled it `false` unconditionally.
 */
export type PtyChildProcessVerdict = 'children' | 'no-children' | 'unverifiable'

/** Reasons the renderer could not observe the execution host.
 *  O3: `terminal_gone` is reserved for the host's own claim (`relay/pty-handler.ts`'s real
 *  session/tombstone miss) -- an in-process registry miss on THIS side of the wire
 *  (`terminal_handle_stale`, `terminal_exited`, `no_connected_pty`, a `PTY "<id>" not found`
 *  message) is a weaker, client-side absence and must not borrow the host-proven spelling. See
 *  docs/reference/ssh-execution-boundary.md's `terminal_gone` paragraph. */
export type ClientOnlyUnverifiableReason =
  | 'transport_loss'
  | 'timeout'
  | 'terminal_gone'
  | 'terminal_handle_stale'
  | 'terminal_exited'
  | 'no_connected_pty'
  | 'terminal_not_found'
  | 'old_host'

/**
 * A renderer-only verdict. Host identity fields are explicitly forbidden so a
 * transport failure cannot be promoted into a synthetic host observation.
 */
export type ClientOnlyUnverifiableInspection = {
  foregroundProcess: null
  hasChildProcesses: false
  verdict: 'unverifiable'
  reason: string
  foregroundProcessEvidence?: never
  childProcessEvidence?: never
  authorityGeneration?: never
  observationEpoch?: never
  capturedAgeMs?: never
  ptyId?: never
  ptyIncarnationId?: never
}

/** Compatibility-shaped host/local inspection returned by the inspect RPC. */
export type HostProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  /** Optional on old hosts; the renderer treats an omitted field as old-host unverifiable. */
  foregroundProcessEvidence?: RemoteForegroundEvidence
  /** Absent on hosts that predate the member, and on answers the host did not pay to observe. */
  childProcessEvidence?: PtyChildProcessVerdict
  verdict?: never
  reason?: never
}

export type TerminalProcessInspection = HostProcessInspection | ClientOnlyUnverifiableInspection

export function clientOnlyUnverifiableInspection(reason: string): ClientOnlyUnverifiableInspection {
  return {
    foregroundProcess: null,
    hasChildProcesses: false,
    verdict: 'unverifiable',
    reason
  }
}

export function isClientOnlyUnverifiableInspection(
  value: unknown
): value is ClientOnlyUnverifiableInspection {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { verdict?: unknown }).verdict === 'unverifiable'
  )
}

/**
 * Whether a `showTerminal` that yielded nothing is the execution owner itself saying the terminal
 * is gone. A resolved null (`showTerminalFailure === undefined`) is the owner answering "no such
 * terminal"; a thrown PTY-host `terminal_gone` code or message is the same claim from further down
 * the stack. Every other failure -- a transport timeout, `terminal_handle_stale`,
 * `terminal_not_found`, an unclassified throw -- is loss of contact, never proof of absence (O1/O2).
 * Shared by the local worker observer and its federation twin (O4) so the two gates cannot drift.
 */
export function isOwnerProvenTerminalAbsence(showTerminalFailure: unknown): boolean {
  if (showTerminalFailure === undefined) {
    return true
  }
  const code =
    showTerminalFailure && typeof showTerminalFailure === 'object' && 'code' in showTerminalFailure
      ? String((showTerminalFailure as { code?: unknown }).code)
      : undefined
  return (
    code === 'terminal_gone' ||
    (showTerminalFailure instanceof Error && showTerminalFailure.message === 'terminal_gone')
  )
}

/**
 * Classify only failures that mean the execution host could not be observed.
 * Unexpected programming errors deliberately return null and remain throws.
 */
export function classifyTerminalProcessInspectionFailure(
  error: unknown
): ClientOnlyUnverifiableReason | null {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  // O3: each of these is a client-side registry miss (a renderer graph-epoch mismatch, this
  // process's own hasPty/adapter lookup finding nothing, ...), not the execution owner
  // confirming absence -- so each earns its own honest reason instead of the host-proven
  // 'terminal_gone' spelling below.
  if (code === 'terminal_handle_stale' || message.includes('terminal_handle_stale')) {
    return 'terminal_handle_stale'
  }
  if (code === 'terminal_exited' || message.includes('terminal_exited')) {
    return 'terminal_exited'
  }
  if (code === 'no_connected_pty' || message.includes('no_connected_pty')) {
    return 'no_connected_pty'
  }
  if (/PTY\s+"[^"]+"\s+not found/i.test(message)) {
    return 'terminal_not_found'
  }
  if (code === 'terminal_gone' || message.includes('terminal_gone')) {
    return 'terminal_gone'
  }
  if (
    code === 'SSH_MUX_REQUEST_TIMEOUT' ||
    code === 'request_timeout' ||
    code === 'rpc_timeout' ||
    code === 'deadline_exceeded' ||
    /\b(?:timed?\s*out|timeout)\b/i.test(message)
  ) {
    return 'timeout'
  }
  if (
    code === 'method_not_found' ||
    code === 'rpc_method_not_found' ||
    code === 'unsupported_method' ||
    /(?:method|inspectProcess).*not found|unsupported.*(?:method|inspect)/i.test(message)
  ) {
    return 'old_host'
  }
  if (
    code === 'CONNECTION_LOST' ||
    code === 'DISPOSED' ||
    code === 'socket_closed' ||
    code === 'connection_closed' ||
    code === 'transport_closed' ||
    code === 'runtime_unavailable' ||
    code === 'remote_runtime_unavailable' ||
    /(?:connection\s+(?:lost|closed)|socket\s+(?:closed|lost)|terminal\s+closed|runtime\s+unavailable|reconnecting|multiplexer\s+disposed|request\s+closed)/i.test(
      message
    )
  ) {
    return 'transport_loss'
  }
  return null
}
