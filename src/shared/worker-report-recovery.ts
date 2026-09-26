import { z } from 'zod'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { WorkerReportOutbox } from './worker-report-outbox'
import { WORKER_REPORT_RETRY_WINDOW_MS, type WorkerReportInput } from './worker-report-record'

const Lifecycle = z.object({
  lifecycle: z.object({
    action: z.string(),
    outcome: z.string().optional(),
    code: z.string().optional(),
    authority: z.string().optional()
  }),
  relay: z.unknown().optional()
})
const TERMINAL_CODES = new Set([
  'run_destination_unsupported',
  'run_destination_unresolved',
  'invalid_argument',
  'request_mismatch',
  'invalid_capability',
  'dispatch_capability_invalid',
  'dispatch_capability_revoked'
])

export function workerReportDisposition(response: RuntimeRpcResponse<unknown>): {
  accepted: boolean
  rejected?: string
} {
  if (!response.ok) {
    return {
      accepted: false,
      ...(TERMINAL_CODES.has(response.error.code) ? { rejected: response.error.code } : {})
    }
  }
  const parsed = Lifecycle.safeParse(response.result)
  if (!parsed.success) {
    return { accepted: false }
  }
  const { lifecycle, relay } = parsed.data
  if (lifecycle.action === 'rejected') {
    return { accepted: false, rejected: lifecycle.code ?? 'lifecycle_rejected' }
  }
  if (
    relay !== undefined &&
    lifecycle.authority !== 'run_home' &&
    lifecycle.authority !== 'worker_server_legacy'
  ) {
    return { accepted: false }
  }
  return {
    accepted:
      lifecycle.action === 'completed' ||
      lifecycle.action === 'failed' ||
      (lifecycle.action === 'settled' &&
        (lifecycle.outcome === 'succeeded' || lifecycle.outcome === 'failed'))
  }
}

export async function drainWorkerReports(
  store: WorkerReportOutbox,
  send: (input: WorkerReportInput) => Promise<RuntimeRpcResponse<unknown>>,
  now = Date.now(),
  onRejected: (requestId: string, code: string) => void = () => undefined,
  shouldContinue: () => boolean = () => true
): Promise<{ pending: number }> {
  for (const candidate of (await store.pending())
    .filter((record) => record.nextAttemptAt <= now)
    .sort(
      (left, right) => left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt
    )
    .slice(0, 16)) {
    if (!shouldContinue()) {
      break
    }
    const record = await store.claim(candidate.input.requestId, now)
    if (!record) {
      continue
    }
    if (!shouldContinue()) {
      break
    }
    if (now - record.createdAt > WORKER_REPORT_RETRY_WINDOW_MS) {
      await store.settle(record.input.requestId, 'report_retry_expired', now)
      onRejected(record.input.requestId, 'report_retry_expired')
      continue
    }
    let response: RuntimeRpcResponse<unknown>
    try {
      response = await send(record.input)
    } catch (error) {
      // The durable claim retains custody through transport loss or a process crash.
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'transport_unknown'
      response = { id: record.input.requestId, ok: false, error: { code, message: '' } }
    }
    if (!shouldContinue()) {
      break
    }
    const disposition = workerReportDisposition(response)
    if (disposition.accepted || disposition.rejected) {
      await store.settle(record.input.requestId, disposition.rejected, now)
      if (disposition.rejected) {
        onRejected(record.input.requestId, disposition.rejected)
      }
    }
  }
  return { pending: (await store.pending()).length }
}
