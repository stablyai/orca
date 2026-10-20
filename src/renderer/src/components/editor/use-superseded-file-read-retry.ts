import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { FileContent } from './editor-panel-content-types'

// Why a cap: a file rewritten faster than it can be read must end in a retryable error, not a loop.
const MAX_SUPERSEDED_READ_RETRIES = 3
const SUPERSEDED_READ_ERROR = 'The file kept changing while it was loading. Try again.'

/**
 * Whatever superseded a tab's read (Keep, another record of the file, an invalidation elsewhere)
 * may never publish text to this panel, so a tab still showing nothing reads again, a few times.
 */
export function useSupersededFileReadRetry({
  fileContentsRef,
  fileReadGenerationRef,
  setFileContents
}: {
  /** What the panel shows now; without it a superseded read always reads again. */
  fileContentsRef?: MutableRefObject<Record<string, FileContent>>
  fileReadGenerationRef: MutableRefObject<Record<string, number>>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
}): {
  retrySuperseded: (id: string, generation: number, reread: () => void) => void
  clearSupersededRetries: (id: string) => void
} {
  const retriesRef = useRef<Record<string, number>>({})
  const retrySuperseded = useCallback(
    (id: string, generation: number, reread: () => void): void => {
      if (
        fileContentsRef?.current[id] !== undefined ||
        fileReadGenerationRef.current[id] !== generation
      ) {
        return
      }
      const retries = (retriesRef.current[id] ?? 0) + 1
      if (retries > MAX_SUPERSEDED_READ_RETRIES) {
        delete retriesRef.current[id]
        setFileContents((prev) => ({
          ...prev,
          [id]: { content: '', isBinary: false, loadError: SUPERSEDED_READ_ERROR }
        }))
        return
      }
      retriesRef.current[id] = retries
      reread()
    },
    [fileContentsRef, fileReadGenerationRef, setFileContents]
  )
  const clearSupersededRetries = useCallback((id: string): void => {
    delete retriesRef.current[id]
  }, [])
  return { retrySuperseded, clearSupersededRetries }
}
