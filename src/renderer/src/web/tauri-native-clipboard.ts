import {
  assertClipboardImageBase64LengthWithinLimit,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit,
  clipboardImageThumbnailSize,
  type ClipboardImageThumbnail
} from '../../../shared/clipboard/clipboard-image'
import { invokePlugin } from './tauri-native-host'

type ClipboardImagePixels = {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

type ClipboardImageResource = {
  image: ClipboardImagePixels
}

function asFiniteDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function parseClipboardImagePixels(size: unknown, rgba: unknown): ClipboardImagePixels | null {
  if (typeof size !== 'object' || size === null || Array.isArray(size)) {
    return null
  }
  const width = asFiniteDimension('width' in size ? size.width : undefined)
  const height = asFiniteDimension('height' in size ? size.height : undefined)
  if (width === null || height === null) {
    return null
  }
  assertClipboardImageDimensionsWithinLimit({ width, height })
  const bytes = Array.isArray(rgba)
    ? rgba
    : rgba instanceof Uint8Array
      ? [...rgba]
      : rgba instanceof ArrayBuffer
        ? [...new Uint8Array(rgba)]
        : null
  if (bytes === null || bytes.length !== width * height * 4) {
    return null
  }
  if (!bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return null
  }
  return { width, height, rgba: Uint8ClampedArray.from(bytes) }
}

async function readClipboardImageResource(): Promise<ClipboardImageResource | null> {
  let rid: number | null = null
  try {
    rid = await invokePlugin<number>('clipboard-manager', 'read_image')
    const [size, rgba] = await Promise.all([
      invokePlugin<unknown>('image', 'size', { rid }),
      invokePlugin<unknown>('image', 'rgba', { rid })
    ])
    const image = parseClipboardImagePixels(size, rgba)
    return image ? { image } : null
  } catch {
    return null
  } finally {
    if (rid !== null) {
      await invokePlugin('resources', 'close', { rid }).catch(() => {})
    }
  }
}

function imageDataUrl(
  image: ClipboardImagePixels,
  size: Pick<ClipboardImagePixels, 'width' | 'height'> = image
): string {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas 2D context is unavailable.')
  }
  const imageData = new ImageData(image.width, image.height)
  imageData.data.set(image.rgba)
  if (size === image) {
    context.putImageData(imageData, 0, 0)
    return canvas.toDataURL('image/png')
  }
  const source = document.createElement('canvas')
  source.width = image.width
  source.height = image.height
  const sourceContext = source.getContext('2d')
  if (!sourceContext) {
    throw new Error('Canvas 2D context is unavailable.')
  }
  sourceContext.putImageData(imageData, 0, 0)
  context.drawImage(source, 0, 0, size.width, size.height)
  return canvas.toDataURL('image/png')
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function readTauriClipboardImagePngBase64(): Promise<string | null> {
  const resource = await readClipboardImageResource()
  if (!resource) {
    return null
  }
  const prefix = 'data:image/png;base64,'
  const dataUrl = imageDataUrl(resource.image)
  if (!dataUrl.startsWith(prefix)) {
    return null
  }
  const base64 = dataUrl.slice(prefix.length)
  assertClipboardImageBase64LengthWithinLimit(base64.length)
  return base64
}

export async function readTauriClipboardImageThumbnail(): Promise<ClipboardImageThumbnail | null> {
  const resource = await readClipboardImageResource()
  if (!resource) {
    return null
  }
  const { image } = resource
  return {
    dataUrl: imageDataUrl(image, clipboardImageThumbnailSize(image)),
    width: image.width,
    height: image.height
  }
}

export async function tauriClipboardHasImage(): Promise<boolean> {
  return (await readClipboardImageResource()) !== null
}

export async function writeTauriClipboardImage(dataUrl: string): Promise<void> {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) {
    return
  }
  const base64 = dataUrl.slice(prefix.length)
  assertClipboardImageBase64LengthWithinLimit(base64.length)
  const bytes = decodeBase64(base64)
  assertClipboardImageByteLengthWithinLimit(bytes.byteLength)
  let rid: number | null = null
  try {
    rid = await invokePlugin<number>('image', 'from_bytes', { bytes: [...bytes] })
    const size = await invokePlugin<unknown>('image', 'size', { rid })
    if (typeof size !== 'object' || size === null || Array.isArray(size)) {
      return
    }
    const width = asFiniteDimension('width' in size ? size.width : undefined)
    const height = asFiniteDimension('height' in size ? size.height : undefined)
    if (width === null || height === null) {
      return
    }
    assertClipboardImageDimensionsWithinLimit({ width, height })
    await invokePlugin('clipboard-manager', 'write_image', { image: rid })
  } finally {
    if (rid !== null) {
      await invokePlugin('resources', 'close', { rid }).catch(() => {})
    }
  }
}
