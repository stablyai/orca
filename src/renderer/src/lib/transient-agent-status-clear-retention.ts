import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export const TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS = 1024
export const TRANSIENT_AGENT_STATUS_CLEAR_MAX_ID_UTF8_BYTES = 1024
export const TRANSIENT_AGENT_STATUS_CLEAR_MAX_TOTAL_ID_UTF8_BYTES = 1024 * 1024

type WatermarkEntry = {
  watermark: number
  idBytes: number
}

export class TransientAgentStatusClearRegistry {
  private readonly watermarks = new Map<string, WatermarkEntry>()
  private retainedIdBytes = 0
  private overflowWatermark = Number.NEGATIVE_INFINITY

  remember(connectionId: string, clearedAt: number): number | null {
    if (!Number.isFinite(clearedAt)) {
      return null
    }
    const measured = measureUtf8ByteLength(connectionId, {
      stopAfterBytes: TRANSIENT_AGENT_STATUS_CLEAR_MAX_ID_UTF8_BYTES
    })
    if (connectionId.length === 0 || measured.exceededLimit) {
      this.overflowWatermark = Math.max(this.overflowWatermark, clearedAt)
      return null
    }

    const previous = this.watermarks.get(connectionId)
    if (previous) {
      const watermark = Math.max(previous.watermark, clearedAt, this.overflowWatermark)
      this.watermarks.delete(connectionId)
      this.watermarks.set(connectionId, { ...previous, watermark })
      return watermark
    }

    while (
      this.watermarks.size >= TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS ||
      this.retainedIdBytes + measured.byteLength >
        TRANSIENT_AGENT_STATUS_CLEAR_MAX_TOTAL_ID_UTF8_BYTES
    ) {
      const oldestId = this.watermarks.keys().next().value
      if (oldestId === undefined) {
        this.overflowWatermark = Math.max(this.overflowWatermark, clearedAt)
        return null
      }
      const oldest = this.watermarks.get(oldestId)
      this.watermarks.delete(oldestId)
      this.retainedIdBytes -= oldest?.idBytes ?? 0
      this.overflowWatermark = Math.max(
        this.overflowWatermark,
        oldest?.watermark ?? Number.NEGATIVE_INFINITY
      )
    }

    const watermark = Math.max(clearedAt, this.overflowWatermark)
    this.watermarks.set(connectionId, { watermark, idBytes: measured.byteLength })
    this.retainedIdBytes += measured.byteLength
    return watermark
  }

  get(connectionId: string): number | undefined {
    const entry = this.watermarks.get(connectionId)
    return entry?.watermark ?? finiteOrUndefined(this.overflowWatermark)
  }

  evidence(): { connections: number; idBytes: number; overflowWatermark?: number } {
    return {
      connections: this.watermarks.size,
      idBytes: this.retainedIdBytes,
      ...(Number.isFinite(this.overflowWatermark)
        ? { overflowWatermark: this.overflowWatermark }
        : {})
    }
  }
}

export function retainTransientAgentStatusClearedConnection(
  current: Record<string, true>,
  connectionId: string
): Record<string, true> {
  if (
    Object.prototype.hasOwnProperty.call(current, connectionId) ||
    connectionId.length === 0 ||
    measureUtf8ByteLength(connectionId, {
      stopAfterBytes: TRANSIENT_AGENT_STATUS_CLEAR_MAX_ID_UTF8_BYTES
    }).exceededLimit
  ) {
    return current
  }
  const next = { ...current }
  const keys = Object.keys(next)
  const removeCount = Math.max(0, keys.length - TRANSIENT_AGENT_STATUS_CLEAR_MAX_CONNECTIONS + 1)
  for (let index = 0; index < removeCount; index += 1) {
    delete next[keys[index]]
  }
  next[connectionId] = true
  return next
}

function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined
}
