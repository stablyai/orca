import type { IncomingMessage } from 'node:http'

import { classifyTruncatedHookRequest } from '../agent-hook-transport-interference'
import { assertJsonTextStructureWithinLimits } from '../json-text-structure-limit'

export const HOOK_REQUEST_MAX_BYTES = 1_000_000
const HOOK_REQUEST_INITIAL_BUFFER_BYTES = 4 * 1024
const AGENT_HOOK_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 128 * 1024,
  nestingDepth: 64
} as const

export function parseAgentHookJson(content: string): unknown {
  // Cursor on Windows can pipe duplicated BOMs before the JSON (#21421).
  let offset = 0
  while (offset < content.length && content.charCodeAt(offset) === 0xfeff) {
    offset += 1
  }
  const normalizedContent = offset > 0 ? content.slice(offset) : content
  assertJsonTextStructureWithinLimits(normalizedContent, AGENT_HOOK_JSON_STRUCTURE_LIMITS)
  return JSON.parse(normalizedContent) as unknown
}

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
      // Absorb late IncomingMessage errors after cleanup so they cannot become unhandled.
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
      // Bound bytes, including after rejection; UTF-16 length would undercount non-ASCII bodies.
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
        // Managed scripts send JSON or form data; unknown content types retain JSON compatibility.
        settleResolve(body ? parseAgentHookJson(body) : {})
      } catch (error) {
        settleReject(error)
      }
    }
    // Classify incomplete Content-Length on error and close: peer RST and local destroy take different paths (#11217).
    const settleUnfinished = (fallback: Error): void => {
      settleReject(
        classifyTruncatedHookRequest(req.headers['content-length'], byteLength) ?? fallback
      )
    }
    const onError = (err: Error): void => {
      settleUnfinished(err)
    }
    // Slowloris destroy may emit only close; settle it to release buffers.
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
