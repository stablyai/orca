import {
  PANEL_CONTROL_MESSAGE_MAX_BYTES,
  PANEL_MESSAGE_MAX_BYTES,
  PANEL_MESSAGE_RATE_LIMIT
} from './plugin-panel-bridge'

/** Share clock-injected per-plugin size/rate decisions between renderer bridge and tests. */

export type PanelMessageBudget = {
  readonly maxBytes?: number
  /** Returns null when the message may proceed, or a refusal reason. */
  admit(now: number, messageBytes: number): 'oversized' | 'rate_limited' | null
}

export function createPanelMessageBudget(
  limits: { maxBytes?: number; maxMessages?: number; perMs?: number } = {}
): PanelMessageBudget {
  const maxBytes = limits.maxBytes ?? PANEL_MESSAGE_MAX_BYTES
  const maxMessages = limits.maxMessages ?? PANEL_MESSAGE_RATE_LIMIT.maxMessages
  const perMs = limits.perMs ?? PANEL_MESSAGE_RATE_LIMIT.perMs
  const timestamps: number[] = []
  return {
    maxBytes,
    admit(now, messageBytes) {
      while (timestamps.length > 0 && timestamps[0]! <= now - perMs) {
        timestamps.shift()
      }
      const rateLimited = timestamps.length >= maxMessages
      // Malformed/oversized messages still spend rate budget to bound size-estimation work.
      if (rateLimited) {
        return 'rate_limited'
      }
      timestamps.push(now)
      if (messageBytes > maxBytes) {
        return 'oversized'
      }
      return null
    }
  }
}

/** Keep liveness size-only so pongs cannot spend a count budget and starve replies; callers also charge the data budget. */
export function createPanelControlMessageBudget(): PanelMessageBudget {
  return {
    maxBytes: PANEL_CONTROL_MESSAGE_MAX_BYTES,
    admit: (_now, messageBytes) =>
      messageBytes > PANEL_CONTROL_MESSAGE_MAX_BYTES ? 'oversized' : null
  }
}

const textEncoder = new TextEncoder()

function utf8Bytes(value: string, stopAfter: number): number {
  // UTF-8 bytes cannot undercut code-unit count; avoid encoding a string already proven oversized.
  if (value.length > stopAfter) {
    return stopAfter + 1
  }
  return textEncoder.encode(value).byteLength
}

/** Bound cloneable-message size by UTF-8 strings/backing bytes, handling cycles and stopping once the cap is exceeded. */
export function structuredCloneMessageBytes(
  data: unknown,
  stopAfter = PANEL_MESSAGE_MAX_BYTES
): number {
  const seen = new WeakSet<object>()
  let total = 0
  let visitedNodes = 0

  const add = (bytes: number): void => {
    total = Math.min(stopAfter + 1, total + bytes)
  }

  const visit = (value: unknown, depth: number): void => {
    if (total > stopAfter) {
      return
    }
    if (value === null) {
      add(1)
      return
    }
    switch (typeof value) {
      case 'undefined':
      case 'boolean':
        add(1)
        return
      case 'number':
        add(8)
        return
      case 'bigint':
        add(utf8Bytes(value.toString(), stopAfter - total))
        return
      case 'string':
        add(utf8Bytes(value, stopAfter - total))
        return
      case 'symbol':
      case 'function':
        total = stopAfter + 1
        return
      case 'object':
        break
    }
    const object = value as object
    if (seen.has(object)) {
      add(8)
      return
    }
    seen.add(object)
    visitedNodes += 1
    if (visitedNodes > 10_000 || depth > 100) {
      total = stopAfter + 1
      return
    }

    if (object instanceof ArrayBuffer) {
      add(object.byteLength)
      return
    }
    if (typeof SharedArrayBuffer !== 'undefined' && object instanceof SharedArrayBuffer) {
      add(object.byteLength)
      return
    }
    if (ArrayBuffer.isView(object)) {
      add(16)
      visit(object.buffer, depth + 1)
      return
    }
    if (typeof Blob !== 'undefined' && object instanceof Blob) {
      add(object.size)
      return
    }
    if (object instanceof Date) {
      add(8)
      return
    }
    if (object instanceof RegExp) {
      visit(object.source, depth + 1)
      visit(object.flags, depth + 1)
      return
    }
    if (object instanceof Map) {
      add(8)
      for (const [key, entry] of object) {
        add(4)
        visit(key, depth + 1)
        visit(entry, depth + 1)
        if (total > stopAfter) {
          return
        }
      }
      return
    }
    if (object instanceof Set) {
      add(8)
      for (const entry of object) {
        add(4)
        visit(entry, depth + 1)
        if (total > stopAfter) {
          return
        }
      }
      return
    }
    if (Array.isArray(object)) {
      add(8)
      for (const entry of object) {
        add(4)
        visit(entry, depth + 1)
        if (total > stopAfter) {
          return
        }
      }
      return
    }
    try {
      const prototype = Object.getPrototypeOf(object)
      if (prototype !== Object.prototype && prototype !== null) {
        total = stopAfter + 1
        return
      }
      for (const key of Object.keys(object)) {
        add(4)
        add(utf8Bytes(key, stopAfter - total))
        visit((object as Record<string, unknown>)[key], depth + 1)
        if (total > stopAfter) {
          return
        }
      }
    } catch {
      total = stopAfter + 1
    }
  }

  visit(data, 0)
  return total
}
