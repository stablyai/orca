import type { NativeChatPtyWriter } from '@/components/native-chat/native-chat-pty-writer'

const pendingWrites = new Map<string, Promise<boolean>>()

function writeAccepted(ptyId: string, data: string): Promise<boolean> {
  const prior = pendingWrites.get(ptyId) ?? Promise.resolve(true)
  const next = prior
    .then(
      () => window.api.terminalPreview.input(ptyId, data),
      () => window.api.terminalPreview.input(ptyId, data)
    )
    .catch(() => false)
  pendingWrites.set(ptyId, next)
  void next.finally(() => {
    if (pendingWrites.get(ptyId) === next) {
      pendingWrites.delete(ptyId)
    }
  })
  return next
}

/** Routes the secondary renderer through its authorized, presence-locked PTY lane. */
export const dashboardNativeChatPtyWriter: NativeChatPtyWriter = {
  requiresWriteAcceptance: true,
  write: (_settings, ptyId, data) => {
    void writeAccepted(ptyId, data)
    return true
  },
  writeAccepted: (_settings, ptyId, data) => writeAccepted(ptyId, data)
}
