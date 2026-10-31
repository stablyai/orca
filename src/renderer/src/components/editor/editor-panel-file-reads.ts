import type { FileContent, InFlightContentRead } from './editor-panel-content-types'
import type { EditorPanelContentLoadOptions } from './useEditorPanelExternalContentEvents'

const inFlightFileReads = new Map<string, InFlightContentRead<FileContent>>()

export function readEditorPanelFileContent(
  key: string,
  options: EditorPanelContentLoadOptions | undefined,
  startRead: () => Promise<FileContent>
): Promise<FileContent> {
  const registeredRead = inFlightFileReads.get(key)
  if (
    options?.force &&
    (options.externalEventGeneration === undefined ||
      registeredRead?.externalEventGeneration !== options.externalEventGeneration)
  ) {
    // Forced reloads must bypass reads started before the external change.
    inFlightFileReads.delete(key)
  }
  let pending = inFlightFileReads.get(key)
  if (!pending) {
    const promise = startRead()
    pending = { externalEventGeneration: options?.externalEventGeneration, promise }
    inFlightFileReads.set(key, pending)
    queueMicrotask(() => {
      if (inFlightFileReads.get(key) === pending) {
        inFlightFileReads.delete(key)
      }
    })
  }
  return pending.promise
}
