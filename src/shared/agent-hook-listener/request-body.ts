import type { IncomingMessage } from 'node:http'

import { classifyTruncatedHookRequest } from '../agent-hook-transport-interference'
import { assertJsonTextStructureWithinLimits } from '../json-text-structure-limit'

/** Maximum request body size accepted by the listener (1 MB). */
export const HOOK_REQUEST_MAX_BYTES = 1_000_000
const HOOK_REQUEST_INITIAL_BUFFER_BYTES = 4 * 1024
const AGENT_HOOK_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 128 * 1024,
  nestingDepth: 64
} as const

export function parseAgentHookJson(content: string): unknown {
  // Why: Cursor on Windows writes UTF-8-with-BOM to the hook's stdin and `JSON.parse` rejects U+FEFF,
  // so the whole event was dropped. Strip exactly one leading BOM — not a trim — to keep every other
  // malformed payload rejected as before.
  const normalizedContent = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  assertJsonTextStructureWithinLimits(normalizedContent, AGENT_HOOK_JSON_STRUCTURE_LIMITS)
  return JSON.parse(normalizedContent) as unknown
}
// ─── Body parsing ───────────────────────────────────────────────────

export function parseFormEncodedBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body)
  const parsed: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    parsed[key] = value
  }
  return parsed
}

export function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let retained = Buffer.alloc(0)
    let byteLength = 0
    let settled = false
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onClose)
      // Why: keep a neutral error sink so a late IncomingMessage error after cleanup can't become unhandled.
      req.on('error', ignoreSettledRequestError)
    }
    const settleResolve = (value: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(value)
    }
    const settleReject = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      // Why: bound by bytes (not UTF-16 units) and stop accumulating after rejection so a client can't push memory past the cap.
      const nextByteLength = byteLength + chunk.length
      if (nextByteLength > HOOK_REQUEST_MAX_BYTES) {
        settleReject(new Error('payload too large'))
        req.destroy()
        return
      }
      if (retained.length < nextByteLength) {
        const nextCapacity = Math.min(
          HOOK_REQUEST_MAX_BYTES,
          Math.max(HOOK_REQUEST_INITIAL_BUFFER_BYTES, retained.length * 2, nextByteLength)
        )
        const next = Buffer.allocUnsafe(nextCapacity)
        retained.copy(next, 0, 0, byteLength)
        retained = next
      }
      chunk.copy(retained, byteLength)
      byteLength = nextByteLength
    }
    const onEnd = (): void => {
      try {
        const body = retained.toString('utf8', 0, byteLength)
        const contentType = req.headers['content-type'] ?? ''
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
          settleResolve(body ? parseAgentHookJson(body) : {})
          return
        }
        if (
          typeof contentType === 'string' &&
          contentType.includes('application/x-www-form-urlencoded')
        ) {
          settleResolve(parseFormEncodedBody(body))
          return
        }
        // Why: managed scripts POST JSON, updated POSIX scripts form-encoded; default to JSON for unknown content types.
        settleResolve(body ? parseAgentHookJson(body) : {})
      } catch (error) {
        settleReject(error)
      }
    }
    // Why (#11217): a body cut short of its own Content-Length is the fingerprint of an IDS
    // resetting the connection mid-inspection. Classify on every path that ends the request without
    // 'end' — a peer RST surfaces as 'error' (ECONNRESET) and only a local destroy reaches 'close' first.
    const settleUnfinished = (fallback: Error): void => {
      settleReject(
        classifyTruncatedHookRequest(req.headers['content-length'], byteLength) ?? fallback
      )
    }
    const onError = (err: Error): void => {
      settleUnfinished(err)
    }
    // Why: req.destroy() (slowloris timer) emits 'close' but not 'end'/'error'; without this the promise never settles and buffers leak.
    const onClose = (): void => {
      settleUnfinished(new Error('aborted'))
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onClose)
  })
}

export function ignoreSettledRequestError(): void {}
