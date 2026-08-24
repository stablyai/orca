// Containers the mobile viewer can play natively (AVPlayer on iOS, ExoPlayer on
// Android). WebM/MKV are left out: iOS cannot decode them, so they stay on the
// unavailable-binary path instead of opening a player that fails.
export const VIDEO_FILE_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime'
}

export const VIDEO_FILE_EXTENSIONS = Object.freeze(Object.keys(VIDEO_FILE_MIME_TYPES))
