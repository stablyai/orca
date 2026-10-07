import { z } from 'zod'
import { imageCheckpointMetadataBytes } from '@xterm/addon-image/src/ImageCheckpointMetadata'
import {
  validateTerminalModelCheckpointMetadata,
  type TerminalModelCheckpointMetadata
} from './terminal-model-checkpoint'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const color = z.object({ rgba: count.max(0xffffffff) }).strict()
const imageOptions = z
  .object({
    enableSizeReports: z.boolean().optional(),
    pixelLimit: count.optional(),
    storageLimit: z.number().finite().optional(),
    showPlaceholder: z.boolean().optional(),
    sixelSupport: z.boolean().optional(),
    sixelScrolling: z.boolean().optional(),
    sixelPaletteLimit: count.optional(),
    sixelSizeLimit: count.optional(),
    iipSupport: z.boolean().optional(),
    iipSizeLimit: count.optional(),
    kittySupport: z.boolean().optional(),
    kittySizeLimit: count.optional()
  })
  .strict()
const configuration = z
  .object({
    cols: count.positive(),
    rows: count.positive(),
    scrollback: count.optional(),
    pathFlavor: z.enum(['posix', 'win32']).optional(),
    remotePosixFileUriAuthority: z.boolean().optional(),
    wslDistro: z.string().optional(),
    images: z
      .object({
        cellSize: z
          .object({ width: z.number().finite().positive(), height: z.number().finite().positive() })
          .strict(),
        colors: z
          .object({ foreground: color, background: color, ansi: z.array(color).max(256) })
          .strict(),
        options: imageOptions.optional()
      })
      .strict()
  })
  .strict()
const modes = z
  .object({
    bracketedPaste: z.boolean(),
    mouseTracking: z.boolean(),
    mouseTrackingMode: z.enum(['none', 'x10', 'vt200', 'drag', 'any']).optional(),
    sgrMouseMode: z.boolean().optional(),
    sgrMousePixelsMode: z.boolean().optional(),
    applicationCursor: z.boolean(),
    alternateScreen: z.boolean(),
    kittyKeyboardFlags: count.optional()
  })
  .strict()
const snapshot = z
  .object({
    snapshotAnsi: z.string(),
    pendingEscapeTailAnsi: z.string().optional(),
    scrollbackAnsi: z.string(),
    oscLinks: z
      .array(z.object({ row: count, startCol: count, endCol: count, uri: z.string() }).strict())
      .optional(),
    rehydrateSequences: z.string(),
    frameRestoreAnsi: z.string().optional(),
    cwd: z.string().nullable(),
    modes,
    cols: count.positive(),
    rows: count.positive(),
    scrollbackLines: count,
    lastTitle: z.string().optional(),
    outputSequence: count.optional(),
    terminalOwner: z.literal('shell').optional()
  })
  .strict()
const graphics = z
  .object({
    version: z.literal(1),
    activeBuffer: z.enum(['normal', 'alternate']),
    components: z
      .array(
        z
          .object({
            kind: z.enum([
              'decoded',
              'kitty-sources',
              'kitty-pending',
              'iip-pending',
              'sixel-state',
              'kitty-active',
              'iip-active',
              'sixel-active'
            ]),
            metadata: z.unknown(),
            resourceIds: z.array(count.positive()).max(8192)
          })
          .strict()
      )
      .min(1)
      .max(8),
    resources: z.array(z.object({ id: count.positive(), byteLength: count }).strict()).max(8192),
    resourceByteLength: count,
    metadataByteLength: count,
    byteLength: count
  })
  .strict()
const header = z
  .object({
    version: z.literal(1),
    configuration,
    snapshot,
    graphics,
    metadataByteLength: count,
    byteLength: count
  })
  .strict()

/** Admit unknown wire metadata before it becomes a complete model contract. */
export function parseTerminalModelCheckpointMetadata(
  value: unknown
): TerminalModelCheckpointMetadata {
  imageCheckpointMetadataBytes(value)
  return validateTerminalModelCheckpointMetadata(header.parse(value))
}
