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

  /** Recheck when `busy` settles: a finished turn may have changed files, a returning host may now answer. */
  function useRecheckNativeChatFileLinksWhenSettled(
    existence: NativeChatFileLinkExistence | null,
    busy: boolean
  ): void {
    const seen = useRef<{ existence: NativeChatFileLinkExistence | null; busy: boolean } | null>(
      null
    )
    useEffect(() => {
      const previous = seen.current
      seen.current = { existence, busy }
      if (existence && previous?.existence === existence && previous.busy && !busy) {
        existence.recheck()
      }
    }, [existence, busy])
  }

  return { useNativeChatFileLinkExistsFrom, useRecheckNativeChatFileLinksWhenSettled }
}
