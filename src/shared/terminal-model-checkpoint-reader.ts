import { z } from 'zod'
import {
  CHECKPOINT_CHUNK_BYTES,
  CHECKPOINT_LEASE_BYTES
} from '@xterm/addon-image/src/ImageCheckpointResources'
import { IMAGE_CHECKPOINT_METADATA_BYTES } from '@xterm/addon-image/src/ImageCheckpointMetadata'
import { TerminalModelCheckpoint } from './terminal-model-checkpoint'
import { parseTerminalModelCheckpointMetadata } from './terminal-model-checkpoint-schema'
import type { TerminalModelCheckpointTransport } from './terminal-model-checkpoint-lease'

export const terminalModelCheckpointLeaseSchema = z
  .object({
    version: z.literal(1),
    leaseId: z.string().uuid(),
    ptyId: z.string().min(1).max(512),
    incarnationId: z.string().min(1).max(512),
    sourceSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    metadataByteLength: z.number().int().positive().max(IMAGE_CHECKPOINT_METADATA_BYTES),
    byteLength: z.number().int().nonnegative().max(CHECKPOINT_LEASE_BYTES)
  })
  .strict()

export type ReceivedTerminalModelCheckpoint = {
  checkpoint: TerminalModelCheckpoint
  sourceSeq: number
}

/** Copies one fenced host capture; the caller owns the complete model on success. */
export async function readTerminalModelCheckpoint(
  transport: TerminalModelCheckpointTransport,
  id: string,
  incarnationId: string,
  isCurrent: () => boolean
): Promise<ReceivedTerminalModelCheckpoint | null> {
  const check = (): void => {
    if (!isCurrent()) {
      throw new Error('Terminal checkpoint request is stale')
    }
  }
  check()
  const response: unknown = await transport.captureModelCheckpoint(id, incarnationId)
  if (response === null) {
    check()
    return null
  }
  // Even rejected descriptors can name a real host allocation that needs release.
  const releaseId = z.object({ leaseId: z.string().uuid() }).safeParse(response)
  const resources = new Map<number, Uint8Array>()
  let checkpoint: TerminalModelCheckpoint | undefined
  let sourceSeq: number | undefined
  let transferred = false
  try {
    check()
    const lease = terminalModelCheckpointLeaseSchema.parse(response)
    if (lease.ptyId !== id || lease.incarnationId !== incarnationId) {
      throw new Error('Terminal checkpoint owner does not match request')
    }
    const read = async (resourceId: number | null, byteLength: number): Promise<Uint8Array> => {
      check()
      const bytes = new Uint8Array(byteLength)
      for (let offset = 0; offset < byteLength; offset += CHECKPOINT_CHUNK_BYTES) {
        const length = Math.min(CHECKPOINT_CHUNK_BYTES, byteLength - offset)
        const chunk = await transport.readModelCheckpoint(id, {
          leaseId: lease.leaseId,
          resourceId,
          offset,
          length
        })
        check()
        if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length) {
          throw new Error('Invalid terminal checkpoint resource chunk')
        }
        bytes.set(chunk, offset)
      }
      return bytes
    }
    const metadata = await read(null, lease.metadataByteLength)
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata))
    const header = parseTerminalModelCheckpointMetadata(parsed)
    if (header.byteLength !== lease.byteLength) {
      throw new Error('Terminal checkpoint size does not match lease')
    }
    if (
      header.snapshot.outputSequence !== undefined &&
      header.snapshot.outputSequence !== lease.sourceSeq
    ) {
      throw new Error('Terminal checkpoint sequence does not match lease')
    }
    const ids = new Set<number>()
    let resourceBytes = 0
    for (const resource of header.graphics.resources) {
      if (ids.has(resource.id)) {
        throw new Error('Duplicate terminal checkpoint resource')
      }
      ids.add(resource.id)
      resourceBytes += resource.byteLength
    }
    if (
      resourceBytes !== header.graphics.resourceByteLength ||
      resourceBytes + header.metadataByteLength !== header.byteLength
    ) {
      throw new Error('Invalid terminal checkpoint resource budget')
    }
    for (const resource of header.graphics.resources) {
      resources.set(resource.id, await read(resource.id, resource.byteLength))
    }
    checkpoint = new TerminalModelCheckpoint(header, resources)
    check()
    sourceSeq = lease.sourceSeq
    transferred = true
  } finally {
    if (!transferred) {
      checkpoint?.dispose()
      resources.clear()
    }
    if (releaseId.success) {
      // Reload/crash already revokes the host lease; it must not discard owned copies.
      try {
        await transport.releaseModelCheckpoint(id, releaseId.data.leaseId)
      } catch {
        // Host expiry remains the backstop if the document loses its connection.
      }
    }
  }
  try {
    check()
    if (!checkpoint || sourceSeq === undefined) {
      throw new Error('Missing complete terminal checkpoint')
    }
    return { checkpoint, sourceSeq }
  } catch (error) {
    checkpoint?.dispose()
    throw error
  }
}
