import type { z } from 'zod'
import { isRecord } from '../is-record'
import { MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES } from './bridge-limits'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from './bridge-protocol-version'
import { isExactMobileWebJsonDocument } from './exact-json-document'

export type MobileWebBridgeMessageContext = {
  shellSessionId: string
  buildId: string
}

export type MobileWebBridgeMessageParseResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: 'invalid_message' | 'too_large' | 'unsupported_version' | 'stale_session'
    }

export function parseMobileWebBridgeMessage<T extends MobileWebBridgeMessageContext>(
  raw: string,
  expected: MobileWebBridgeMessageContext,
  schema: z.ZodType<T>
): MobileWebBridgeMessageParseResult<T> {
  const parsed = parseMobileWebBridgeMessageDocument(raw, schema)
  if (!parsed.ok) {
    return parsed
  }
  if (
    parsed.value.shellSessionId !== expected.shellSessionId ||
    parsed.value.buildId !== expected.buildId
  ) {
    return { ok: false, error: 'stale_session' }
  }
  return parsed
}

export function parseMobileWebBridgeMessageDocument<T>(
  raw: string,
  schema: z.ZodType<T>
): MobileWebBridgeMessageParseResult<T> {
  if (new TextEncoder().encode(raw).byteLength > MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES) {
    return { ok: false, error: 'too_large' }
  }
  if (!isExactMobileWebJsonDocument(raw)) {
    return { ok: false, error: 'invalid_message' }
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'invalid_message' }
  }
  if (
    isRecord(value) &&
    'version' in value &&
    value.version !== MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
  ) {
    return { ok: false, error: 'unsupported_version' }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, error: 'invalid_message' }
  }
  return { ok: true, value: parsed.data }
}
