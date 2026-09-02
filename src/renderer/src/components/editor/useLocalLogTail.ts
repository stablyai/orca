import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { LocalLogTailChangedPayload } from '../../../../shared/local-log-tail-types'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'
import { LocalLogTailDecoder } from './local-log-tail-decoder'

type TailSession = {
  fileId: string
  filePath: string
  subscriptionId: string
  decoder: LocalLogTailDecoder
  closed: boolean
  reading: boolean
  pendingRead: boolean
  limited: boolean
  startPromise: Promise<void>
}

type UseLocalLogTailParams = {
  openFiles: OpenFile[]
  fileContents: Record<string, FileContent>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
  reloadContent: (file: OpenFile) => void
}

let nextSubscriptionId = 0

function isLocalLiveLog(
  file: OpenFile,
  content: FileContent | undefined
): content is FileContent & {
  fileIdentity: string
} {
  return (
    file.mode === 'edit' &&
    file.readOnly === true &&
    file.liveTail === true &&
    (file.runtimeEnvironmentId ?? null) === null &&
    file.relativePath === file.filePath &&
    content !== undefined &&
    content.isBinary === false &&
    !content.loadError &&
    typeof content.fileIdentity === 'string' &&
    content.fileIdentity.length > 0
  )
}

function stopTailSession(session: TailSession): void {
  if (session.closed) {
    return
  }
  session.closed = true
  // Why: start IPC can still be resolving when a tab closes. Stop only after
  // start settles so a late-created main-process watcher cannot escape cleanup.
  void session.startPromise
    .then(() => window.api.fs.stopLocalLogTail({ subscriptionId: session.subscriptionId }))
    .catch(() => {})
}

export function useLocalLogTail({
  openFiles,
  fileContents,
  setFileContents,
  reloadContent
}: UseLocalLogTailParams): void {
  const sessionsRef = useRef(new Map<string, TailSession>())
  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles
  const reloadContentRef = useRef(reloadContent)
  reloadContentRef.current = reloadContent
  const hasLocalLiveTailFile = openFiles.some(
    (file) => file.readOnly === true && file.liveTail === true
  )

  const restartFromSnapshot = useCallback((session: TailSession): void => {
    const file = openFilesRef.current.find((candidate) => candidate.id === session.fileId)
    stopTailSession(session)
    sessionsRef.current.delete(session.fileId)
    if (file) {
      reloadContentRef.current(file)
    }
  }, [])

  const drain = useCallback(
    async (session: TailSession): Promise<void> => {
      if (session.closed || session.limited) {
        return
      }
      if (session.reading) {
        session.pendingRead = true
        return
      }
      session.reading = true
      let appendedContent = ''
      let discardAppends = false
      try {
        do {
          session.pendingRead = false
          for (;;) {
            const result = await window.api.fs.readLocalLogTail({
              filePath: session.filePath,
              fromByteOffset: session.decoder.nextByteOffset,
              expectedIdentity: session.decoder.expectedIdentity
            })
            if (session.closed) {
              return
            }
            const decoded = session.decoder.apply(result)
            if (decoded.kind === 'reset') {
              discardAppends = true
              restartFromSnapshot(session)
              return
            }
            if (decoded.kind === 'limit') {
              session.limited = true
              void session.startPromise
                .then(() =>
                  window.api.fs.stopLocalLogTail({ subscriptionId: session.subscriptionId })
                )
                .catch(() => {})
              console.warn('[ai-vault] stopped live tail at the editor file-size limit')
              return
            }
            appendedContent += decoded.content
            if (!decoded.hasMore) {
              break
            }
          }
        } while (session.pendingRead && !session.closed)
      } catch (error) {
        if (!session.closed) {
          console.warn('[ai-vault] local log tail read failed', error)
        }
      } finally {
        session.reading = false
        if (appendedContent && !discardAppends && !session.closed) {
          setFileContents((previous) => {
            const current = previous[session.fileId]
            if (!current || current.isBinary || current.loadError) {
              return previous
            }
            return {
              ...previous,
              [session.fileId]: { ...current, content: current.content + appendedContent }
            }
          })
        }
      }
    },
    [restartFromSnapshot, setFileContents]
  )

  useEffect(() => {
    if (!hasLocalLiveTailFile) {
      return
    }
    const unsubscribe = window.api.fs.onLocalLogTailChanged(
      ({ subscriptionId, eventType }: LocalLogTailChangedPayload) => {
        const session = Array.from(sessionsRef.current.values()).find(
          (candidate) => candidate.subscriptionId === subscriptionId
        )
        if (!session) {
          return
        }
        if (eventType === 'rename') {
          restartFromSnapshot(session)
          return
        }
        void drain(session)
      }
    )
    return unsubscribe
  }, [drain, hasLocalLiveTailFile, restartFromSnapshot])

  useEffect(() => {
    const liveFileIds = new Set<string>()
    for (const file of openFiles) {
      const content = fileContents[file.id]
      if (!isLocalLiveLog(file, content)) {
        continue
      }
      liveFileIds.add(file.id)
      if (sessionsRef.current.has(file.id)) {
        continue
      }

      const decoder = new LocalLogTailDecoder(content.content, content.fileIdentity)
      const subscriptionId = `local-log-tail-${++nextSubscriptionId}`
      const session: TailSession = {
        fileId: file.id,
        filePath: file.filePath,
        subscriptionId,
        decoder,
        closed: false,
        reading: false,
        pendingRead: false,
        limited: false,
        startPromise: Promise.resolve()
      }
      sessionsRef.current.set(file.id, session)

      if (decoder.initialVisibleContent !== content.content) {
        setFileContents((previous) => {
          const current = previous[file.id]
          return current
            ? {
                ...previous,
                [file.id]: { ...current, content: decoder.initialVisibleContent }
              }
            : previous
        })
      }

      session.startPromise = window.api.fs.startLocalLogTail({
        filePath: file.filePath,
        subscriptionId
      })
      void session.startPromise
        .then(() => {
          if (session.closed) {
            return
          }
          // Why: this first drain closes the snapshot/watch installation race.
          return drain(session)
        })
        .catch((error) => {
          if (!session.closed) {
            console.warn('[ai-vault] local log tail watch failed', error)
          }
        })
    }

    for (const [fileId, session] of sessionsRef.current) {
      if (!liveFileIds.has(fileId)) {
        stopTailSession(session)
        sessionsRef.current.delete(fileId)
      }
    }
  }, [drain, fileContents, openFiles, setFileContents])

  useEffect(
    () => () => {
      for (const session of sessionsRef.current.values()) {
        stopTailSession(session)
      }
      sessionsRef.current.clear()
    },
    []
  )
}
