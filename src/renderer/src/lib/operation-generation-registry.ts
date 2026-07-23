import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export type OperationGenerationRegistryBounds = {
  maxEntries: number
  maxKeyBytes: number
  maxTotalKeyBytes: number
}

export const DEFAULT_OPERATION_GENERATION_REGISTRY_BOUNDS: OperationGenerationRegistryBounds = {
  maxEntries: 8_192,
  maxKeyBytes: 64 * 1024,
  maxTotalKeyBytes: 4 * 1024 * 1024
}

type RetainedGeneration = {
  generation: number
  keyBytes: number
}

export class OperationGenerationRegistry {
  private readonly generations = new Map<string, RetainedGeneration>()
  private retainedKeyBytes = 0
  private nextGeneration = 0

  constructor(
    private readonly bounds: OperationGenerationRegistryBounds = DEFAULT_OPERATION_GENERATION_REGISTRY_BOUNDS
  ) {
    if (
      !Number.isSafeInteger(bounds.maxEntries) ||
      bounds.maxEntries < 1 ||
      !Number.isSafeInteger(bounds.maxKeyBytes) ||
      bounds.maxKeyBytes < 1 ||
      !Number.isSafeInteger(bounds.maxTotalKeyBytes) ||
      bounds.maxTotalKeyBytes < 1
    ) {
      throw new RangeError('Operation generation registry bounds must be positive integers')
    }
  }

  get(key: string): number {
    const retained = this.generations.get(key)
    if (!retained) {
      // Why: a miss may be an eviction, so reusing zero could admit a stale capture.
      return this.replace(key)
    }
    this.generations.delete(key)
    this.generations.set(key, retained)
    return retained.generation
  }

  advance(key: string): number {
    return this.replace(key)
  }

  delete(key: string): void {
    const retained = this.generations.get(key)
    if (!retained) {
      return
    }
    this.generations.delete(key)
    this.retainedKeyBytes -= retained.keyBytes
  }

  evidence(): { entries: number; keyBytes: number } {
    return {
      entries: this.generations.size,
      keyBytes: this.retainedKeyBytes
    }
  }

  private replace(key: string): number {
    this.delete(key)
    const generation = ++this.nextGeneration
    const measurement = measureUtf8ByteLength(key, {
      stopAfterBytes: this.bounds.maxKeyBytes
    })
    if (measurement.exceededLimit || measurement.byteLength > this.bounds.maxTotalKeyBytes) {
      return generation
    }
    while (
      this.generations.size >= this.bounds.maxEntries ||
      this.retainedKeyBytes + measurement.byteLength > this.bounds.maxTotalKeyBytes
    ) {
      const oldest = this.generations.keys().next().value
      if (oldest === undefined) {
        return generation
      }
      this.delete(oldest)
    }
    this.generations.set(key, {
      generation,
      keyBytes: measurement.byteLength
    })
    this.retainedKeyBytes += measurement.byteLength
    return generation
  }
}
