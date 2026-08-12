/**
 * Differential guard: a transport error's CODE must not classify as fatal when its own
 * MESSAGE reads as recoverable.
 *
 * Since #12667, `isRecoverableRemoteRuntimeConnectionError` and
 * `isRuntimeRpcQueueOverloadError` treat a present code as authoritative and consult
 * `RECOVERABLE_MESSAGE_FRAGMENTS` only when there is no code. A transient code missing from
 * `RECOVERABLE_CODES` therefore classifies as fatal, and a fatal classification is what
 * dead-ends a terminal pane (#12650: the transport cancels recovery, unmounting the Reconnect
 * banner). This file enumerates the reachable (code, message) pairs and fails if any pair takes
 * that shape, plus pins that the code-less fragment fallback still works for untyped producers.
 *
 * The reverse direction — recoverable code, fatal-reading message — is deliberately allowed:
 * that is the code doing its job (e.g. 'Refreshing remote runtime control transport.' carries
 * remote_runtime_unavailable and no fragment would have rescued it).
 *
 * WHAT THIS GUARD CANNOT CATCH: a transient code whose message matches no fragment. The
 * message side has nothing to disagree with, so the pair looks consistent. `remote_runtime_busy`
 * is exactly that case today — its messages say "retry after…" but match no fragment, so it
 * classifies fatal and this guard stays silent. Tracked as STA-3479; do not "fix" it here.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  RECOVERABLE_CODES,
  RECOVERABLE_MESSAGE_FRAGMENTS,
  isRecoverableRemoteRuntimeConnectionError,
  isRuntimeRpcQueueOverloadError,
  toRemoteRuntimeClientErrorLike,
  type RemoteRuntimeClientErrorLike
} from './remote-runtime-client-error-classification'
import {
  invalidRemoteRuntimeResponseError,
  parseAuthenticatedFrame,
  parseReadyFrame,
  parseRemoteRuntimeRpcFrame,
  remoteRuntimeTimeoutError,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'
import { formatSharedControlCloseMessage } from './remote-runtime-shared-control-protocol'
import { RuntimeRpcCallQueueOverloadError } from './runtime-rpc-call-queue'
import { withRemoteRuntimeTailscaleHint } from './remote-runtime-tailscale-hint'
import { MAX_TIMER_DELAY_MS } from './timer-delay'

type TransportErrorPair = RemoteRuntimeClientErrorLike & { producer: string }

/** Derives the pair from the real producer so a message edit updates the corpus with it. */
function producedPair(producer: string, error: unknown): TransportErrorPair {
  return { producer, ...toRemoteRuntimeClientErrorLike(error) }
}

function frameError(producer: string, frame: string): TransportErrorPair {
  const parsed = parseRemoteRuntimeRpcFrame(frame)
  return producedPair(producer, parsed.type === 'error' ? parsed.error : parsed)
}

// Why: these two live behind socket callbacks / module-private helpers that a unit test cannot
// reach, so their close-code shapes are reproduced here rather than derived.
const CLOSE_REASON = Buffer.from('server restarting')
const EMPTY_CLOSE_REASON = Buffer.from('')

const REQUEST_TRANSPORT_ERRORS: TransportErrorPair[] = [
  {
    producer: 'remote-runtime-client.ts:120',
    code: 'invalid_argument',
    message: `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
  },
  {
    producer: 'remote-runtime-client.ts:192',
    code: 'runtime_timeout',
    message: 'Timed out waiting for the remote Orca runtime to respond.'
  },
  {
    producer: 'remote-runtime-client.ts:238 / :639',
    code: 'invalid_argument',
    message: 'Invalid remote endpoint: Invalid URL'
  },
  {
    producer: 'remote-runtime-client.ts:258 / :654',
    code: 'remote_runtime_unavailable',
    message: 'Could not connect to the remote Orca runtime.'
  },
  {
    producer: 'remote-runtime-client.ts:270 / :667 (formatRemoteRuntimeCloseMessage, 1006)',
    code: 'remote_runtime_unavailable',
    message: 'Remote Orca runtime closed the connection.'
  },
  {
    producer: 'remote-runtime-client.ts:270 / :667 (formatRemoteRuntimeCloseMessage, 1011)',
    code: 'remote_runtime_unavailable',
    message: `Remote Orca runtime closed the connection (1011: ${CLOSE_REASON.toString()}).`
  },
  {
    producer: 'remote-runtime-client.ts:289',
    code: 'invalid_runtime_response',
    message: 'Remote Orca runtime returned an unexpected binary frame.'
  },
  {
    producer: 'remote-runtime-client.ts:310 / :693',
    code: 'invalid_runtime_response',
    message: 'Remote Orca runtime returned an undecryptable frame.'
  },
  {
    producer: 'remote-runtime-client.ts:393 / :801 (rejected token)',
    code: 'unauthorized',
    message: 'Remote Orca runtime rejected the pairing token.'
  },
  {
    producer: 'remote-runtime-client.ts:393 / :801 (unparseable auth failure)',
    code: 'invalid_runtime_response',
    message: 'Remote Orca runtime rejected the pairing token.'
  },
  {
    producer: 'remote-runtime-client.ts:415',
    code: 'remote_runtime_unavailable',
    message: 'Remote Orca runtime request was released before it could be sent.'
  },
  {
    producer: 'remote-runtime-client.ts:459 / :829',
    code: 'invalid_runtime_response',
    message: 'Remote Orca runtime returned a mismatched response id.'
  },
  {
    producer: 'remote-runtime-client.ts:476 (non-Error status validation failure)',
    code: 'runtime_error',
    message: 'status preflight rejected'
  },
  {
    producer: 'remote-runtime-client.ts:556',
    code: 'runtime_timeout',
    message: 'Timed out waiting for the remote Orca runtime subscription to start.'
  },
  {
    producer: 'remote-runtime-client.ts:587',
    code: 'remote_runtime_unavailable',
    message: 'Remote Orca runtime send buffer overflow; reconnecting.'
  },
  {
    producer: 'remote-runtime-client.ts:735',
    code: 'remote_runtime_unavailable',
    message: 'Remote Orca runtime stopped responding; the stream connection was reset.'
  },
  {
    producer: 'remote-runtime-client.ts:842',
    code: 'invalid_runtime_response',
    message: 'Remote Orca runtime returned binary data before authentication.'
  },
  {
    producer: 'remote-runtime-client.ts:852',
    code: 'invalid_runtime_response',
    message: 'Remote Orca runtime returned an undecryptable binary frame.'
  },
  {
    producer: 'remote-runtime-request-websocket.ts:115',
    code: 'invalid_argument',
    message: 'Invalid remote pairing key: bad base64'
  },
  {
    producer: 'remote-runtime-request-websocket.ts:127',
    code: 'invalid_argument',
    message: 'Invalid remote endpoint: Invalid URL'
  },
  {
    producer: 'remote-runtime-memory-limits.ts:26',
    code: 'invalid_argument',
    message: 'Remote runtime JSON payload exceeds 8388608 bytes.'
  },
  {
    producer: 'remote-runtime-memory-limits.ts:32',
    code: 'invalid_argument',
    message: 'Remote runtime JSON payload could not be serialized: Converting circular structure'
  },
  {
    producer: 'remote-runtime-memory-limits.ts:48',
    code: 'invalid_argument',
    message: 'Remote runtime subscription parameters exceed 1048576 bytes.'
  },
  {
    producer: 'remote-runtime-memory-limits.ts:54',
    code: 'invalid_argument',
    message:
      'Remote runtime subscription parameters could not be serialized: Converting circular structure'
  },
  producedPair('remote-runtime-request-frames.ts:24', remoteRuntimeUnavailableError()),
  producedPair('remote-runtime-request-frames.ts:30', remoteRuntimeTimeoutError()),
  producedPair('remote-runtime-request-frames.ts:46', parseReadyFrame('not-json')),
  producedPair('remote-runtime-request-frames.ts:55', parseReadyFrame('{"type":"nope"}')),
  producedPair('remote-runtime-request-frames.ts:67', parseAuthenticatedFrame('not-json')),
  producedPair(
    'remote-runtime-request-frames.ts:81 (rejected token)',
    parseAuthenticatedFrame(JSON.stringify({ error: { code: 'unauthorized' } }))
  ),
  producedPair(
    'remote-runtime-request-frames.ts:81 (unrecognized auth frame)',
    parseAuthenticatedFrame(JSON.stringify({ type: 'e2ee_other' }))
  ),
  frameError('remote-runtime-request-frames.ts:91', 'not-json'),
  frameError('remote-runtime-request-frames.ts:103', JSON.stringify({ not: 'an envelope' })),
  producedPair(
    'remote-runtime-request-frames.ts:37 (invalid handshake frame)',
    invalidRemoteRuntimeResponseError('Remote Orca runtime returned an invalid E2EE auth frame.')
  ),
  producedPair(
    'runtime-rpc-call-queue.ts:70 / :74 / :81',
    new RuntimeRpcCallQueueOverloadError('global')
  )
]

const SHARED_CONTROL_TRANSPORT_ERRORS: TransportErrorPair[] = [
  producedPair(
    'remote-runtime-shared-control-open.ts:37 (1006)',
    remoteRuntimeUnavailableError(formatSharedControlCloseMessage(1006, EMPTY_CLOSE_REASON))
  ),
  producedPair(
    'remote-runtime-shared-control-open.ts:37 (1011 with reason)',
    remoteRuntimeUnavailableError(formatSharedControlCloseMessage(1011, CLOSE_REASON))
  ),
  producedPair(
    'remote-runtime-shared-control-open.ts:37 (1011 without reason)',
    remoteRuntimeUnavailableError(formatSharedControlCloseMessage(1011, EMPTY_CLOSE_REASON))
  ),
  producedPair(
    'remote-runtime-shared-control-open.ts:86',
    remoteRuntimeUnavailableError(
      'Remote Orca runtime stopped responding; resetting the control connection.'
    )
  ),
  producedPair(
    'remote-runtime-shared-control-connection.ts:138',
    remoteRuntimeUnavailableError('Refreshing remote runtime control transport.')
  ),
  producedPair(
    'remote-runtime-shared-control-subscription-start.ts:48',
    remoteRuntimeUnavailableError('Remote runtime subscription closed before it started.')
  ),
  {
    producer: 'remote-runtime-shared-control-protocol.ts:160 / :162 (toRemoteRuntimeClientError)',
    code: 'runtime_error',
    message: 'Unexpected shared control failure'
  },
  {
    producer: 'remote-runtime-prepared-request-admission.ts:96',
    code: 'runtime_error',
    message: 'prepared request admission failed'
  }
]

/**
 * `remote_runtime_busy` is semantically transient but absent from `RECOVERABLE_CODES`, so it
 * classifies fatal. It is listed here (not omitted) so the corpus stays complete; STA-3479
 * covers the classification itself.
 */
const BUSY_TRANSPORT_ERRORS: TransportErrorPair[] = [
  {
    producer: 'remote-runtime-prepared-request-admission.ts:100',
    code: 'remote_runtime_busy',
    message: 'Remote runtime request limit reached; retry after pending requests finish.'
  },
  {
    producer: 'remote-runtime-shared-control-admission.ts:17',
    code: 'remote_runtime_busy',
    message: 'Remote runtime subscription limit reached; close a subscription and retry.'
  },
  {
    producer: 'remote-runtime-shared-control-admission.ts:27',
    code: 'remote_runtime_busy',
    message: 'Remote runtime subscription memory limit reached; close a subscription and retry.'
  },
  {
    producer: 'remote-runtime-shared-control-ready.ts:25',
    code: 'remote_runtime_busy',
    message: 'Remote runtime connection wait limit reached; retry after pending work finishes.'
  }
]

/**
 * Codes the host forwards through `mapRuntimeError`, reconstructed by `RuntimeRpcCallError`.
 * `RUNTIME_PASSTHROUGH_CODES` entries arrive with the code as their own message; the
 * `STRUCTURED_RUNTIME_PASSTHROUGH_CODES` and `runtime_error` entries carry the host's message,
 * which is open-ended — see the limitation note at the bottom of this file.
 */
const HOST_FORWARDED_TRANSPORT_ERRORS: TransportErrorPair[] = [
  {
    producer: 'main/runtime/rpc/errors.ts:155 (RUNTIME_PASSTHROUGH_CODES)',
    code: 'runtime_unavailable',
    message: 'runtime_unavailable'
  },
  {
    producer: 'main/runtime/rpc/errors.ts:155 (RUNTIME_PASSTHROUGH_CODES)',
    code: 'timeout',
    message: 'timeout'
  },
  {
    producer: 'main/runtime/rpc/errors.ts:155 (RUNTIME_PASSTHROUGH_CODES)',
    code: 'terminal_gone',
    message: 'terminal_gone'
  },
  {
    producer: 'main/runtime/rpc/errors.ts:145 (STRUCTURED_RUNTIME_PASSTHROUGH_CODES)',
    code: 'remote_runtime_unavailable',
    message: 'Remote Orca runtime closed the connection.'
  },
  {
    producer: 'main/runtime/rpc/errors.ts:145 (STRUCTURED_RUNTIME_PASSTHROUGH_CODES)',
    code: 'runtime_timeout',
    message: 'Timed out waiting for the remote Orca runtime to respond.'
  },
  {
    producer: 'main/runtime/rpc/errors.ts:145 (STRUCTURED_RUNTIME_PASSTHROUGH_CODES)',
    code: 'invalid_runtime_response',
    message: 'Remote Orca runtime returned an invalid response frame.'
  },
  {
    producer: 'main/runtime/rpc/errors.ts:145 (STRUCTURED_RUNTIME_PASSTHROUGH_CODES)',
    code: 'capability_unsupported',
    message: 'Remote host does not support this capability.'
  },
  {
    producer: 'main/runtime/rpc/errors.ts:161 (runtime_error fallthrough)',
    code: 'runtime_error',
    message: 'Worktree is missing on the remote host.'
  }
]

// Why: main rewrites the message of an already-coded error before it crosses IPC, so the
// hinted variants are distinct corpus members.
const TAILSCALE_HINTED_TRANSPORT_ERRORS: TransportErrorPair[] = [
  {
    producer: 'main/ipc/runtime-environment-transport-routing.ts:153',
    code: 'remote_runtime_unavailable',
    message: withRemoteRuntimeTailscaleHint(
      'Could not connect to the remote Orca runtime.',
      'https://desk.example.com'
    )
  },
  {
    producer: 'main/ipc/runtime-environment-transport-routing.ts:200',
    code: 'remote_runtime_unavailable',
    message: withRemoteRuntimeTailscaleHint(
      'Remote Orca runtime closed the connection.',
      'https://desk.tail1234.ts.net'
    )
  }
]

const CODED_TRANSPORT_ERRORS: TransportErrorPair[] = [
  ...REQUEST_TRANSPORT_ERRORS,
  ...SHARED_CONTROL_TRANSPORT_ERRORS,
  ...BUSY_TRANSPORT_ERRORS,
  ...HOST_FORWARDED_TRANSPORT_ERRORS,
  ...TAILSCALE_HINTED_TRANSPORT_ERRORS
]

/** Untyped producers that still depend on the message-fragment fallback. */
const CODELESS_TRANSPORT_ERRORS: (TransportErrorPair & { recoverable: boolean })[] = [
  {
    producer: 'web-runtime-client.ts:117 / :328',
    message: 'Remote Orca runtime is not connected.',
    recoverable: true
  },
  {
    producer: 'web-runtime-client.ts:359 / :360 / :591',
    message: 'Remote Orca runtime connection closed.',
    recoverable: true
  },
  {
    producer: 'web-runtime-client.ts:437 / :601',
    message: withRemoteRuntimeTailscaleHint(
      'Could not connect to the remote Orca runtime.',
      'https://desk.example.com'
    ),
    recoverable: true
  },
  {
    producer: 'remote-runtime-terminal-multiplexer.ts:455',
    message: 'Remote terminal stream is not connected.',
    recoverable: true
  },
  {
    producer: 'remote-runtime-terminal-multiplexer.ts:511',
    message: 'Remote Orca runtime closed the connection.',
    recoverable: true
  },
  {
    producer: 'remote-runtime-terminal-multiplexer.ts:1295 / :1308',
    message: 'Remote runtime connection closed.',
    recoverable: true
  },
  {
    producer: 'ipcMain.handle rejection that carries no code',
    message:
      "Error invoking remote method 'runtimeEnvironments:call': RuntimeRpcCallQueueOverloadError: Remote runtime call queue is full; retry after current calls finish.",
    recoverable: true
  },
  {
    producer: 'untyped host rejection with no connection wording',
    message: 'Worktree is missing on the remote host.',
    recoverable: false
  }
]

function matchingRecoverableFragment(message: string): string | null {
  const lowered = message.toLowerCase()
  return RECOVERABLE_MESSAGE_FRAGMENTS.find((fragment) => lowered.includes(fragment)) ?? null
}

function classifyByMessageOnly(pair: TransportErrorPair): boolean {
  return isRecoverableRemoteRuntimeConnectionError({ message: pair.message })
}

describe('transport error code/message classification agreement', () => {
  it('enumerates every reachable coded producer', () => {
    // Floor, not an exact count: the corpus should only grow. Lower it deliberately when a
    // producer is genuinely deleted. (#12667's review enumerated 34 of these by hand.)
    expect(CODED_TRANSPORT_ERRORS.length).toBeGreaterThanOrEqual(57)
    expect(CODED_TRANSPORT_ERRORS.every((pair) => typeof pair.code === 'string')).toBe(true)
  })

  it('never classifies a coded error as fatal while its own message reads as recoverable', () => {
    const violations = CODED_TRANSPORT_ERRORS.filter(
      (pair) => !isRecoverableRemoteRuntimeConnectionError(pair) && classifyByMessageOnly(pair)
    ).map(
      (pair) =>
        `${pair.producer}: code "${pair.code}" classifies fatal but its message matches recoverable fragment "${matchingRecoverableFragment(pair.message)}" — either add "${pair.code}" to RECOVERABLE_CODES in remote-runtime-client-error-classification.ts, or change the message so it no longer reads as a transient connection failure.`
    )
    expect(violations).toEqual([])
  })

  it('never classifies a coded error as non-overload while its own message reads as overload', () => {
    const violations = CODED_TRANSPORT_ERRORS.filter(
      (pair) =>
        !isRuntimeRpcQueueOverloadError(pair) &&
        isRuntimeRpcQueueOverloadError({ message: pair.message })
    ).map(
      (pair) =>
        `${pair.producer}: code "${pair.code}" is not the queue-overload code but its message reads as queue overload — either raise it with RUNTIME_RPC_QUEUE_OVERLOAD_CODE, or change the message.`
    )
    expect(violations).toEqual([])
  })

  it('keeps the code-less fragment fallback intact for untyped producers', () => {
    const misclassified = CODELESS_TRANSPORT_ERRORS.filter(
      (pair) =>
        isRecoverableRemoteRuntimeConnectionError({ message: pair.message }) !== pair.recoverable
    ).map(
      (pair) =>
        `${pair.producer}: expected message-only classification ${pair.recoverable} — untyped producers have no code, so removing a fragment from RECOVERABLE_MESSAGE_FRAGMENTS strands them.`
    )
    expect(misclassified).toEqual([])
  })

  it('backs every recoverable message fragment with a producer in the corpus', () => {
    const allMessages = [...CODED_TRANSPORT_ERRORS, ...CODELESS_TRANSPORT_ERRORS].map((pair) =>
      pair.message.toLowerCase()
    )
    const unbacked = RECOVERABLE_MESSAGE_FRAGMENTS.filter(
      (fragment) => !allMessages.some((message) => message.includes(fragment))
    ).map(
      (fragment) =>
        `recoverable fragment "${fragment}" matches no producer in this corpus — add the producer that emits it, or drop the fragment.`
    )
    expect(unbacked).toEqual([])
  })

  it('backs every recoverable code with a producer in the corpus', () => {
    // 'reconnecting' is vocabulary borrowed from the SSH/runtime status states; no error
    // producer raises it. Kept recoverable defensively.
    const codesWithoutProducer = new Set(['reconnecting'])
    const corpusCodes = new Set(CODED_TRANSPORT_ERRORS.map((pair) => pair.code))
    const unbacked = [...RECOVERABLE_CODES]
      .filter((code) => !corpusCodes.has(code) && !codesWithoutProducer.has(code))
      .map(
        (code) =>
          `recoverable code "${code}" matches no producer in this corpus — add the producer that raises it so its message is checked, or declare it producer-less here.`
      )
    expect(unbacked).toEqual([])
  })

  it('pins why the guard cannot see the remote_runtime_busy exception (STA-3479)', () => {
    for (const pair of BUSY_TRANSPORT_ERRORS) {
      // Fatal by code with a message that matches nothing: the two sides cannot disagree, so the
      // differential above stays silent. Fixing the classification is STA-3479, not this file.
      expect(isRecoverableRemoteRuntimeConnectionError(pair)).toBe(false)
      expect(matchingRecoverableFragment(pair.message)).toBeNull()
    }
  })
})
