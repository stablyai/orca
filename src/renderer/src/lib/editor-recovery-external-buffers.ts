import type { OpenFile } from '@/store/slices/editor'
import { resolveEditorRecovery } from './editor-recovery-checkpoints'

export type ExternalRecoveryBuffer = { file: OpenFile; content: string }
const buffers = new Map<string, ExternalRecoveryBuffer>()
const listeners = new Set<(removed?: ExternalRecoveryBuffer) => void>()
let version = 0

export function getExternalRecoveryBuffers(): ExternalRecoveryBuffer[] {
  return Array.from(buffers.values())
}
export function getExternalRecoveryVersion(): number {
  return version
}
export function subscribeExternalRecoveryBuffers(
  listener: (removed?: ExternalRecoveryBuffer) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function setExternalRecoveryBuffer(buffer: ExternalRecoveryBuffer): void {
  const previous = buffers.get(buffer.file.id)
  if (previous?.file === buffer.file && previous.content === buffer.content) {
    return
  }
  buffers.set(buffer.file.id, buffer)
  version++
  for (const listener of listeners) {
    listener()
  }
}
export function removeExternalRecoveryBuffer(id: string): void {
  const previous = buffers.get(id)
  if (!previous) {
    return
  }
  buffers.delete(id)
  version++
  for (const listener of listeners) {
    listener(previous)
  }
}
export async function retireExternalRecoveryBuffer(
  id: string,
  savedContent: string
): Promise<void> {
  if (buffers.get(id)?.content === savedContent) {
    removeExternalRecoveryBuffer(id)
  }
  await resolveEditorRecovery(id, savedContent)
}
