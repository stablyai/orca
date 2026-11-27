import type { ReadClipboardTextOptions } from './clipboard-text'

export type ReadClipboardPasteContentOptions = ReadClipboardTextOptions & {
  /** Also return the HTML flavor when it may carry links. */
  linkHtml?: boolean
  /** Probe for an image even when there is text; otherwise only text-less clipboards are probed. */
  probeImage?: boolean
}

/** Everything one paste needs, read from a single clipboard snapshot. */
export type ClipboardPasteContent = {
  text: string
  /** Empty if no files were copied or the host cannot list them. */
  filePaths: string[]
  /** Empty unless requested and the HTML may carry links. */
  linkHtml: string
  /** False when not probed (text present without `probeImage`). */
  hasImage: boolean
}
