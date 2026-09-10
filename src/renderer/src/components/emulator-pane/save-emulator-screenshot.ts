import { canvasToPngDataUrl } from '@/lib/canvas-png-data-url'

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

export async function saveEmulatorScreenshot(
  canvas: HTMLCanvasElement,
  now: Date
): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> {
  const dataUrl = await canvasToPngDataUrl(canvas)
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('Emulator screenshot was not encoded as a PNG.')
  }
  return window.api.fs.saveDownloadedFile({
    suggestedName: `emulator-screenshot-${now.toISOString().replace(/[:.]/g, '-')}.png`,
    content: dataUrl.slice(PNG_DATA_URL_PREFIX.length),
    encoding: 'base64'
  })
}
