/** A remote text save larger than one request, sent in chunks to a temp in the host's staging folder. */
export const STAGED_FILE_SAVE_RUNTIME_CAPABILITY = 'files.write.staged.v1' as const

export const STAGED_FILE_SAVE_METHODS = {
  begin: 'files.saveBegin',
  chunk: 'files.saveChunk',
  commit: 'files.saveCommit',
  abort: 'files.saveAbort'
} as const

/**
 * Any file into a workspace folder, staged the same way, so an unfinished upload never leaves a file
 * there. Chunks and abort use the save methods; the commit creates the file and refuses a taken name.
 */
export const STAGED_FILE_UPLOAD_RUNTIME_CAPABILITY = 'files.upload.staged.v1' as const

export const STAGED_FILE_UPLOAD_METHODS = {
  begin: 'files.uploadBegin',
  chunk: STAGED_FILE_SAVE_METHODS.chunk,
  commit: 'files.uploadCommit',
  abort: STAGED_FILE_SAVE_METHODS.abort
} as const

// Raw bytes per chunk; base64 makes 512 KiB, inside REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES.
export const STAGED_FILE_SAVE_CHUNK_BYTES = 384 * 1024

export const STAGED_FILE_SAVE_LIMITS = {
  // The largest file the editor opens from a remote host (PAGED_REMOTE_FILE_MAX_BYTES); uploads share it.
  maxBytesPerSave: 50 * 1024 * 1024,
  maxSavesPerConnection: 2,
  maxBytesPerConnection: 100 * 1024 * 1024,
  maxSavesPerHost: 8,
  // A save no chunk has touched for this long is dropped with its temp.
  idleMs: 2 * 60 * 1000
}
