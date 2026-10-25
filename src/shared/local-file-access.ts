/**
 * The kind of file access a desktop request declares, which decides what main checks. Absent means the path must
 * be inside a project root main recognises.
 */
export type LocalFileAccess =
  /** A single file the user named (gesture or persisted tab): read in place, regular files only. */
  | { kind: 'user-file' }
  /** A resource a document's content references (images): limited to that document's roots or folder. */
  | { kind: 'document-resource'; documentPath: string }
  /** An image a chat transcript or composer shows: any local image file; a network share only inside a project. */
  | { kind: 'chat-image' }
  /** A document the user opened: renaming it to any path, or adding files in its own folder. */
  | { kind: 'document-folder'; documentPath: string }

/** Main's refusal of a request that resolves outside every root it may serve. */
export const PATH_OUTSIDE_ALLOWED_DIRECTORIES =
  'Access denied: path resolves outside allowed directories'

// Why match the message: IPC errors cross to the renderer as plain messages, without their class.
export function isPathOutsideAllowedDirectoriesError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
}
