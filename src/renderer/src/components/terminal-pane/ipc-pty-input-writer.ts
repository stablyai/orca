import { createPtyInputWriteQueue } from './pty-input-write-queue'

export function createIpcPtyInputWriter(
  isWritable: (id: string) => boolean,
  onDrainFailure: (id: string) => void
) {
  return createPtyInputWriteQueue({
    isWritable,
    write: (id, data, inputKind, inputOrigin) =>
      inputOrigin
        ? window.api.pty.write(id, data, inputKind, inputOrigin)
        : window.api.pty.write(id, data, inputKind),
    writeAccepted: (id, data, inputKind, inputOrigin) =>
      inputOrigin
        ? window.api.pty.writeAccepted(id, data, inputKind, { inputOrigin })
        : window.api.pty.writeAccepted(id, data, inputKind),
    onDrainFailure
  })
}
