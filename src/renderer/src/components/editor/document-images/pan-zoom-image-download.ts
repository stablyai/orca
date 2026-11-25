import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { PanZoomSize } from '../../../../../shared/document-preview/pan-zoom-view'
import { renderImagePngDataUrl } from './image-png-export'

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
}
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)$/i

function safeBaseName(title: string): string {
  return title.replace(/[/\\:*?"<>|]+/g, '-').trim() || 'image'
}

/** The viewer's title as a file name, with an extension that matches the image's type. */
function imageDownloadFileName(title: string, type: string): string {
  const base = safeBaseName(title)
  const extension = EXTENSION_BY_TYPE[type.split(';', 1)[0]]
  const current = IMAGE_EXTENSION.exec(base)?.[1].toLowerCase().replace('jpeg', 'jpg')
  if (!extension || current === extension) {
    return base
  }
  return `${base.replace(IMAGE_EXTENSION, '')}.${extension}`
}

async function fetchImageBlob(src: string): Promise<Blob | null> {
  try {
    const response = await fetch(src)
    return response.ok ? await response.blob() : null
  } catch {
    return null
  }
}

function saveAs(href: string, fileName: string): void {
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  link.click()
}

/** Saves the shown image as a file; the browser (or Electron's save dialog) picks where. */
export async function downloadImage(
  src: string,
  title: string,
  size: PanZoomSize | null,
  background: string | undefined
): Promise<void> {
  try {
    const blob = await fetchImageBlob(src)
    if (blob) {
      const url = URL.createObjectURL(blob)
      saveAs(url, imageDownloadFileName(title, blob.type))
      // The download has its own copy of the bytes once started.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return
    }
    if (!size) {
      throw new Error('Could not load image')
    }
    // Sources fetch can't read (e.g. orca-media://) save the same PNG that Copy makes.
    const png = await renderImagePngDataUrl(src, size, background ?? null, false)
    saveAs(png, imageDownloadFileName(title, 'image/png'))
  } catch (error) {
    toast.error(
      translate(
        'auto.components.editor.PanZoomImageDialog.downloadFailed',
        'Could not download the image'
      ),
      { description: error instanceof Error ? error.message : undefined }
    )
  }
}
