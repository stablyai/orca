import { ImageAddon } from '@xterm/addon-image'
import type {
  IImageAddonCheckpoint,
  IImageAddonCheckpointMetadata
} from '@xterm/addon-image/src/ImageCheckpointApi'
import {
  imageCheckpointMetadataBytes,
  ownImageCheckpointMetadata
} from '@xterm/addon-image/src/ImageCheckpointMetadata'
import { CHECKPOINT_LEASE_BYTES } from '@xterm/addon-image/src/ImageCheckpointResources'
import { advancePartialEscapeTail } from './terminal-partial-escape-tail'
import {
  validateModelCheckpointConfiguration,
  type HeadlessModelConfiguration
} from './terminal-model-checkpoint-configuration'
import type { TerminalSnapshot } from './terminal-snapshot'

export type TerminalModelCheckpointMetadata = {
  version: 1
  configuration: HeadlessModelConfiguration
  snapshot: TerminalSnapshot
  graphics: IImageAddonCheckpointMetadata
  metadataByteLength: number
  byteLength: number
}

export function validateTerminalModelCheckpointMetadata(
  metadata: TerminalModelCheckpointMetadata
): TerminalModelCheckpointMetadata {
  const owned = ownImageCheckpointMetadata(metadata)
  validateModelCheckpointConfiguration(owned.configuration)
  const { snapshot } = owned
  if (
    owned.version !== 1 ||
    snapshot.cols !== owned.configuration.cols ||
    snapshot.rows !== owned.configuration.rows ||
    typeof snapshot.snapshotAnsi !== 'string' ||
    typeof snapshot.scrollbackAnsi !== 'string' ||
    typeof snapshot.rehydrateSequences !== 'string' ||
    (snapshot.cwd !== null && typeof snapshot.cwd !== 'string') ||
    snapshot.modes.alternateScreen !== (owned.graphics.activeBuffer === 'alternate') ||
    owned.metadataByteLength !== imageCheckpointMetadataBytes(owned) ||
    owned.byteLength !== owned.graphics.resourceByteLength + owned.metadataByteLength ||
    owned.byteLength > CHECKPOINT_LEASE_BYTES
  ) {
    throw new Error('Invalid complete terminal checkpoint header')
  }
  const text = snapshot.scrollbackAnsi + snapshot.rehydrateSequences + snapshot.snapshotAnsi
  const imageIntroducers = ['\x1bP', '\x1b_', '\x1b]1337;', '\u0090', '\u009f', '\u009d1337;']
  if (imageIntroducers.some((introducer) => text.includes(introducer))) {
    throw new Error('Image input cannot be replayed as checkpoint text')
  }
  const tail = snapshot.pendingEscapeTailAnsi ?? ''
  if (
    advancePartialEscapeTail('', tail) !== tail ||
    (tail && owned.graphics.components.some((part) => part.kind.endsWith('-active')))
  ) {
    throw new Error('Invalid complete terminal checkpoint parser ownership')
  }
  return owned
}

export class TerminalModelCheckpoint {
  private header: TerminalModelCheckpointMetadata | null
  private readonly graphics: IImageAddonCheckpoint

  constructor(metadata: TerminalModelCheckpointMetadata, resources: Map<number, Uint8Array>) {
    try {
      const owned = validateTerminalModelCheckpointMetadata(metadata)
      this.graphics = ImageAddon.checkpointFromResources(owned.graphics, resources)
      this.header = owned
    } catch (error) {
      resources.clear()
      throw error
    }
  }

  get metadata(): TerminalModelCheckpointMetadata {
    if (!this.header) {
      throw new Error('Complete terminal checkpoint lease is disposed')
    }
    return this.header
  }

  get isDisposed(): boolean {
    return this.header === null || this.graphics.isDisposed
  }

  checkCurrent(): void {
    if (this.isDisposed) {
      throw new Error('Complete terminal checkpoint lease is disposed')
    }
  }

  getResourceByteLength(id: number): number {
    this.checkCurrent()
    return this.graphics.getResourceByteLength(id)
  }
  readResource(id: number, offset: number, length: number): Uint8Array {
    this.checkCurrent()
    return this.graphics.readResource(id, offset, length)
  }
  copyResource(id: number, maxBytes: number): Uint8Array {
    this.checkCurrent()
    return this.graphics.copyResource(id, maxBytes)
  }

  async restoreImages(addon: ImageAddon): Promise<void> {
    this.checkCurrent()
    await addon.restoreCheckpoint(this.graphics)
    this.checkCurrent()
  }

  dispose(): void {
    this.graphics.dispose()
    this.header = null
  }
}
