type RecoveryCheckpoint = { id: string; revision: number; bufferKind: 'edit' | 'diff' }
const checkpoints = new Map<string, RecoveryCheckpoint>()
const flushers = new Set<() => Promise<void>>()
const resolvers = new Set<(fileId: string, savedContent?: string) => Promise<void>>()

export function getEditorRecoveryCheckpoint(fileId: string): RecoveryCheckpoint | undefined {
  return checkpoints.get(fileId)
}
export function setEditorRecoveryCheckpoint(fileId: string, checkpoint: RecoveryCheckpoint): void {
  checkpoints.set(fileId, checkpoint)
}
export function clearEditorRecoveryCheckpoint(fileId: string, id: string): void {
  if (checkpoints.get(fileId)?.id === id) {
    checkpoints.delete(fileId)
  }
}
export function registerEditorRecoveryFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush)
  return () => {
    flushers.delete(flush)
  }
}
export async function flushEditorRecovery(): Promise<void> {
  await Promise.all(Array.from(flushers, (flush) => flush()))
}
export function registerEditorRecoveryResolver(
  resolve: (fileId: string, savedContent?: string) => Promise<void>
): () => void {
  resolvers.add(resolve)
  return () => {
    resolvers.delete(resolve)
  }
}
export async function resolveEditorRecovery(fileId: string, savedContent?: string): Promise<void> {
  await Promise.all(Array.from(resolvers, (resolve) => resolve(fileId, savedContent)))
}
export const OPEN_EDITOR_RECOVERY_EVENT = 'orca:open-editor-recovery'
export function openEditorRecovery(): void {
  window.dispatchEvent(new Event(OPEN_EDITOR_RECOVERY_EVENT))
}
