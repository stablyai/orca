import type { FileContent, InFlightContentRead } from './editor-panel-content-types'

/** One disk read per file, scope and access shared by every panel that asks while it runs. */
export const inFlightFileReads = new Map<string, InFlightContentRead<FileContent>>()

export function inFlightReadKey(connectionId: string | undefined, filePath: string): string {
  return `${connectionId ?? ''}::${filePath}`
}
