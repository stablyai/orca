/** Draw's page image, taken in the same serialized operation that removed the picker from that document. */
export type BrowserCleanPageCapture = { dataUrl: string; width: number; height: number }

export type BrowserCaptureCleanPageArgs = { browserPageId: string; requestId: string }
