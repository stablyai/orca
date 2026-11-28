import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { BrowserTarget, OptionalBoolean, OptionalFiniteNumber } from '../rpc-param-primitives'

// A viewer's stream; each `*: 1` opts into events an older host strips.
export const Screencast = BrowserTarget.extend({
  format: z
    .unknown()
    .optional()
    .transform((v) => (v === 'png' ? 'png' : 'jpeg'))
    .pipe(z.enum(['png', 'jpeg'])),
  quality: OptionalFiniteNumber,
  maxWidth: OptionalFiniteNumber,
  maxHeight: OptionalFiniteNumber,
  viewportWidth: OptionalFiniteNumber,
  viewportHeight: OptionalFiniteNumber,
  deviceScaleFactor: OptionalFiniteNumber,
  mobile: OptionalBoolean,
  everyNthFrame: OptionalFiniteNumber,
  minFrameIntervalMs: OptionalFiniteNumber,
  // Ask for frame credit; the host echoes `frameAck: true` in `ready`. Old hosts strip it.
  frameAck: z.literal(1).optional(),
  // Ask for the page's cursor and hovered link: `ready.pointer`, then `pointer` events. Old hosts strip it.
  pointerEvents: z.literal(1).optional(),
  // Ask the page's permission, sign-in and open-app prompts as `pagePrompt` events. Old hosts strip it.
  pagePrompts: z.literal(1).optional(),
  // Open the pickers this viewer's own input opens on the viewer, as `fileChooser` events. Old hosts strip it.
  fileChoosers: z.literal(1).optional(),
  // Send right presses to the page and receive the menus they open as `contextMenu` events. Old hosts strip it.
  contextMenus: z.literal(1).optional(),
  // Ask where an agent points and presses on the page as `agentCursor` events. Old hosts strip it.
  agentCursor: z.literal(1).optional(),
  // Ask who drives the page (a phone or nobody) as `driver` events, from `ready` on. Old hosts strip it.
  driverEvents: z.literal(1).optional(),
  // Hear the page's downloads start and end as `download*` events. Old hosts strip it.
  downloads: z.literal(1).optional(),
  // With `downloads`: each finished download carries a `copyId` this device can stream here with
  // browser.downloadCopyStream. Old hosts strip it.
  downloadCopyStreams: z.literal(1).optional(),
  // Hear the print() calls this viewer's own input makes as `print` events. Old hosts strip it.
  prints: z.literal(1).optional()
})

export const ScreencastUnsubscribe = lazyZodSchema(() =>
  z.object({
    subscriptionId: z.string().min(1, 'Missing required --subscription-id')
  })
)

export const ScreencastAck = lazyZodSchema(() =>
  z.object({
    subscriptionId: z.string().min(1, 'Missing required --subscription-id'),
    // Cumulative: the newest frame seq the viewer has received.
    seq: z.number().int().nonnegative()
  })
)

// A `driver` event's page, which a phone drives; `all` also takes back the host's other phone-held pages.
export const ScreencastReclaimForDesktop = lazyZodSchema(() =>
  z.object({
    browserPageId: z.string().min(1),
    all: z.literal(true).optional()
  })
)

// A `pagePrompt` event's requestId; `answer` is checked by the prompt's own kind, and null declines it.
export const PagePromptAnswer = lazyZodSchema(() =>
  z.object({
    requestId: z.string().min(1),
    answer: z.unknown()
  })
)

// A `print` event's PDF, read in slices by the device it was handed to.
export const ReleasePrintPdf = lazyZodSchema(() =>
  z.object({
    printId: z.string().min(1)
  })
)

export const ReadPrintPdf = lazyZodSchema(() =>
  ReleasePrintPdf.extend({
    offset: z.number().int().nonnegative().optional()
  })
)

// A `downloadFinished` event's copy, streamed once to the device it was offered to, or let go.
export const ReleaseDownloadCopy = lazyZodSchema(() =>
  z.object({
    copyId: z.string().min(1)
  })
)

export const DownloadCopyStream = lazyZodSchema(() =>
  z.object({
    copyId: z.string().min(1)
  })
)

// A `fileChooser` event's requestId and the host paths the viewer staged; null when the person closed their picker.
export const FileChooserAnswer = lazyZodSchema(() =>
  z.object({
    requestId: z.string().min(1),
    files: z.array(z.string().min(1)).nullable()
  })
)
