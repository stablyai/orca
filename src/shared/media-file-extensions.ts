// Why: Chromium in Electron ships ffmpeg with these codecs, so every listed
// container is natively decodable by <audio>/<video> without extra plugins.
export const MEDIA_FILE_MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
}

export const MEDIA_FILE_EXTENSIONS = Object.freeze(Object.keys(MEDIA_FILE_MIME_TYPES))

export function isMediaPreviewMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false
  }
  return mimeType.startsWith('audio/') || mimeType.startsWith('video/')
}
