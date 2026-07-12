export type LifecycleMessageType = 'worker_done' | 'heartbeat'

export type LifecyclePayload = Record<string, unknown> & {
  taskId: string
  dispatchId: string
}

export type LifecyclePayloadValidation =
  | { ok: true; payload: LifecyclePayload }
  | { ok: false; message: string }

export function isLifecycleMessageType(type: string | undefined): type is LifecycleMessageType {
  return type === 'worker_done' || type === 'heartbeat'
}

function invalidPayload(type: LifecycleMessageType, detail: string): LifecyclePayloadValidation {
  return {
    ok: false,
    message:
      `Invalid ${type} payload: ${detail}. ` +
      'Use --task-id and --dispatch-id instead of raw --payload JSON.'
  }
}

export function validateLifecyclePayload(
  type: LifecycleMessageType,
  rawPayload: string | undefined
): LifecyclePayloadValidation {
  if (!rawPayload) {
    return invalidPayload(type, 'a JSON object payload is required')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawPayload)
  } catch {
    return invalidPayload(type, 'expected valid JSON')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidPayload(type, 'expected a JSON object')
  }

  const payload = parsed as Record<string, unknown>
  if (typeof payload.taskId !== 'string' || payload.taskId.trim().length === 0) {
    return invalidPayload(type, 'taskId must be a non-empty string')
  }
  if (typeof payload.dispatchId !== 'string' || payload.dispatchId.trim().length === 0) {
    return invalidPayload(type, 'dispatchId must be a non-empty string')
  }

  if (
    payload.filesModified !== undefined &&
    (!Array.isArray(payload.filesModified) ||
      !payload.filesModified.every((file) => typeof file === 'string'))
  ) {
    return invalidPayload(type, 'filesModified must be an array of strings')
  }
  if (payload.reportPath !== undefined && typeof payload.reportPath !== 'string') {
    return invalidPayload(type, 'reportPath must be a string')
  }
  if (payload.phase !== undefined && typeof payload.phase !== 'string') {
    return invalidPayload(type, 'phase must be a string')
  }

  return { ok: true, payload: payload as LifecyclePayload }
}
