import type * as React from 'react'
import type { FileLinkExists } from './native-chat-file-link-tree'
import type {
  NativeChatFileLinkExistence,
  NativeChatFileLinkSnapshot
} from './native-chat-file-link-existence'

const subscribeToNothing = (): (() => void) => () => {}
const getNoSnapshot = (): null => null

/** React is passed in: desktop and the phone each bundle their own copy. */
export function createNativeChatFileLinkHooks({
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
}: Pick<typeof React, 'useEffect' | 'useMemo' | 'useRef' | 'useSyncExternalStore'>) {
  /** Undefined when this chat cannot open files, so nothing is underlined. */
  function useNativeChatFileLinkExistsFrom(
    existence: NativeChatFileLinkExistence | null,
    enabled: boolean,
    streaming: boolean
  ): FileLinkExists | undefined {
    const watcher = useMemo(
      () => (enabled && existence ? existence.watch() : null),
      [enabled, existence]
    )
    const getSnapshot = watcher?.getSnapshot ?? getNoSnapshot
    const snapshot: NativeChatFileLinkSnapshot | null = useSyncExternalStore(
      watcher?.subscribe ?? subscribeToNothing,
      getSnapshot,
      getSnapshot
    )
    // Why: text still streaming in ends mid-path; ask the host once the reply settles.
    return snapshot ? (streaming ? snapshot.peek : snapshot.check) : undefined
  }

  /** A finished turn may have created or removed files its text names. */
  function useRecheckNativeChatFileLinksAfterTurn(
    existence: NativeChatFileLinkExistence | null,
    isWorking: boolean
  ): void {
    const seen = useRef<{
      existence: NativeChatFileLinkExistence | null
      isWorking: boolean
    } | null>(null)
    useEffect(() => {
      const previous = seen.current
      seen.current = { existence, isWorking }
      if (existence && previous?.existence === existence && previous.isWorking && !isWorking) {
        existence.recheck()
      }
    }, [existence, isWorking])
  }

  return { useNativeChatFileLinkExistsFrom, useRecheckNativeChatFileLinksAfterTurn }
}
