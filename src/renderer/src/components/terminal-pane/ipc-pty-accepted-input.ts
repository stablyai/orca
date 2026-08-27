import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'

export async function writeAcceptedIpcPtyInput(
  id: string,
  data: string,
  isCurrent: () => boolean
): Promise<boolean> {
  try {
    const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
    if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
      return false
    }
    const chunks = iterateTerminalInputChunks(data)
    let chunk = chunks.next()
    while (!chunk.done) {
      if (!isCurrent()) {
        return false
      }
      const accepted = await window.api.pty.writeAccepted(id, chunk.value)
      if (!accepted) {
        return false
      }
      chunk = chunks.next()
      if (!chunk.done) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    return true
  } catch {
    return false
  }
}
