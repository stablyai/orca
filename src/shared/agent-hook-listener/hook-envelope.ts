import { Buffer } from 'node:buffer'
import type { IncomingHttpHeaders } from 'node:http'

import type { AgentHookSource } from '../agent-hook-relay'
import { parsePaneKey } from '../stable-pane-id'
import { MAX_PANE_KEY_LEN, warnOnHookEnvOrVersionMismatch } from './listener-limits'
import type { HookListenerState } from './listener-state'
import { parseAgentHookJson } from './request-body'

function readHookHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function decodeBase64HookHeader(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    return undefined
  }
  const decoded = Buffer.from(value, 'base64').toString('utf8')
  const normalizedInput = value.replace(/=+$/, '')
  const normalizedRoundTrip = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '')
  return normalizedRoundTrip === normalizedInput ? decoded : undefined
}

function readHookMetadataHeader(
  headers: IncomingHttpHeaders,
  name: string,
  encoding: 'base64' | undefined
): string | undefined {
  const value = readHookHeader(headers, name)
  if (value === undefined) {
    return undefined
  }
  return encoding === 'base64' ? decodeBase64HookHeader(value) : value
}

type HookMetadata = {
  paneKey: string
  tabId?: string
  launchToken?: string
  worktreeId?: string
  env?: string
  version?: string
}

function readPackedHookMetadata(
  headers: IncomingHttpHeaders,
  encoding: 'base64' | undefined
): HookMetadata | null {
  const encoded = readHookHeader(headers, 'x-orca-agent-hook-meta')
  if (encoded === undefined || encoding !== 'base64') {
    return null
  }
  const decoded = decodeBase64HookHeader(encoded)
  if (decoded === undefined) {
    return null
  }
  // POSIX command substitution strips NUL bytes, so use the shell-safe unit separator.
  const fields = decoded.split('\x1f')
  if (fields.length !== 6 || !fields[0]) {
    return null
  }
  const [paneKey, tabId, launchToken, worktreeId, env, version] = fields
  return { paneKey, tabId, launchToken, worktreeId, env, version }
}

/** Rebuilds the canonical envelope for POSIX hooks that carry raw JSON bodies. */
export function mergeAgentHookRequestHeaders(body: unknown, headers: IncomingHttpHeaders): unknown {
  const metadataEncoding =
    readHookHeader(headers, 'x-orca-agent-hook-meta-encoding')?.trim().toLowerCase() === 'base64'
      ? 'base64'
      : undefined
  const metadata = readPackedHookMetadata(headers, metadataEncoding) ?? {
    paneKey: readHookMetadataHeader(headers, 'x-orca-pane-key', metadataEncoding) ?? '',
    tabId: readHookMetadataHeader(headers, 'x-orca-tab-id', metadataEncoding),
    launchToken: readHookMetadataHeader(headers, 'x-orca-launch-token', metadataEncoding),
    worktreeId: readHookMetadataHeader(headers, 'x-orca-worktree-id', metadataEncoding),
    env: readHookMetadataHeader(headers, 'x-orca-agent-hook-env', metadataEncoding),
    version: readHookMetadataHeader(headers, 'x-orca-agent-hook-version', metadataEncoding)
  }
  if (!metadata.paneKey) {
    return body
  }
  return {
    ...metadata,
    payload: body
  }
}
function readEnvelopeString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export type ParsedHookEnvelope = {
  record: Record<string, unknown>
  paneKey: string
  hookPayloadRecord: Record<string, unknown>
  tabId?: string
  worktreeId?: string
  launchToken?: string
}

/** Validates the transport envelope while preserving warning-before-tab-rejection order. */
export function parseHookEnvelope(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string
): ParsedHookEnvelope | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const record = body as Record<string, unknown>
  const paneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
  const parsedPaneKey = parsePaneKey(paneKey)
  const rawPayload = record.payload
  // Antigravity may carry a transition with absent stdin; every other provider requires payload.
  const antigravityPayloadAbsent =
    source === 'antigravity' &&
    (rawPayload === undefined || (typeof rawPayload === 'string' && rawPayload.trim() === ''))
  const hookPayload = antigravityPayloadAbsent
    ? {}
    : typeof rawPayload === 'string'
      ? (() => {
          try {
            return parseAgentHookJson(rawPayload)
          } catch {
            return null
          }
        })()
      : rawPayload
  if (
    !paneKey ||
    paneKey.length > MAX_PANE_KEY_LEN ||
    !parsedPaneKey ||
    typeof hookPayload !== 'object' ||
    hookPayload === null
  ) {
    return null
  }
  warnOnHookEnvOrVersionMismatch(state, {
    version: readEnvelopeString(record, 'version'),
    env: readEnvelopeString(record, 'env'),
    expectedEnv
  })
  const tabId = readEnvelopeString(record, 'tabId')
  if (tabId && tabId !== parsedPaneKey.tabId) {
    return null
  }
  return {
    record,
    paneKey,
    hookPayloadRecord: hookPayload as Record<string, unknown>,
    tabId,
    worktreeId: readEnvelopeString(record, 'worktreeId'),
    launchToken: readEnvelopeString(record, 'launchToken')
  }
}
