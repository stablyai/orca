// Why a new method: older hosts only create binary files (`files.writeBase64` refuses to clobber).
export const FILE_REPLACE_WITH_UPLOAD_RUNTIME_CAPABILITY = 'files.replace-with-upload.v1' as const
export const FILE_REPLACE_WITH_UPLOAD_METHOD = 'files.replaceWithUpload'

export const FILE_BYTES_SAVE_UPDATE_REQUIRED_MESSAGE =
  'Saving binary files here requires a newer Orca server. Update the Orca server and try again.'

/** Raw bytes per `files.writeBase64Chunk` call, so its base64 stays under the remote write cap. */
export const FILE_BYTES_WRITE_CHUNK_BYTES = 384 * 1024

/** Refuse the replacement unless the file's bytes still hash to `expectedSha256`. */
export type FileBytesWritePrecondition = {
  /** Lowercase hex SHA-256 of the bytes the editor loaded; absent only for an explicit Overwrite. */
  expectedSha256?: string
  /** A missing file is written (recreated) instead of refused. */
  allowMissing?: boolean
}
