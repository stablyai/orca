import { useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged
} from '@/runtime/runtime-environment-revision'
import type { FileLinkExists } from '../../../../shared/native-chat/native-chat-file-link-tree'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import {
  createNativeChatFileLinkExistence,
  NativeChatFileLinkExistenceContext
} from './native-chat-file-link-existence'
import type { NativeChatFileLinkExistence } from '../../../../shared/native-chat/native-chat-file-link-existence'
import {
  useNativeChatFileLinkExistsFrom,
  useRecheckNativeChatFileLinksAfterTurn
} from '../../../../shared/native-chat/use-native-chat-file-link-exists'

const subscribeToPairings = (onChange: () => void): (() => void) =>
  onRuntimeEnvironmentRevisionsChanged(onChange)

type FileLinkHostEpoch = {
  /** The SSH connection generation while connected; null while it is not. */
  sshUp: string | null
  /** Changes when the runtime host answers again or is paired again. */
  runtime: string
}

function useFileLinkHostEpoch(
  connectionId: string | null | undefined,
  runtimeEnvironmentId: string | null
): FileLinkHostEpoch {
  const sshUp = useAppStore((s) => {
    const state = connectionId ? s.sshConnectionStates.get(connectionId) : undefined
    return state?.status === 'connected' ? String(state.connectionGeneration ?? 0) : null
  })
  const runtimeStatus = useAppStore((s) => {
    const status = runtimeEnvironmentId
      ? s.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)
      : undefined
    return status ? `${status.connectionGeneration ?? 0}:${status.hostContactEpoch ?? 0}` : ''
  })
  const pairing = useSyncExternalStore(subscribeToPairings, () =>
    runtimeEnvironmentId ? getRuntimeEnvironmentRevision(runtimeEnvironmentId) : undefined
  )
  return { sshUp, runtime: `${runtimeStatus}|${pairing ?? ''}` }
}

function useRecheckWhenHostReturns(
  existence: NativeChatFileLinkExistence | null,
  { sshUp, runtime }: FileLinkHostEpoch
): void {
  const seen = useRef<{
    existence: NativeChatFileLinkExistence | null
    sshUp: string | null
    runtime: string
  } | null>(null)
  useEffect(() => {
    const previous = seen.current
    seen.current = { existence, sshUp, runtime }
    // Fresh checkers are already checking their messages; only retained watchers need a host-return retry.
    if (!existence || previous?.existence !== existence) {
      return
    }
    // Only returning/replaced connections can change file answers; disconnects cannot prove deletion.
    const sshReturned = sshUp !== null && sshUp !== previous.sshUp
    if (sshReturned || runtime !== previous.runtime) {
      existence.recheck()
    }
  }, [existence, sshUp, runtime])
}

export function useRecheckNativeChatFileLinksWhenTurnEnds(isWorking: boolean): void {
  useRecheckNativeChatFileLinksAfterTurn(useContext(NativeChatFileLinkExistenceContext), isWorking)
}

/** One per chat view: paths in its transcript are checked on the workspace's host. */
export function NativeChatFileLinkExistenceProvider({
  tabId,
  children
}: {
  tabId: string
  children: ReactNode
}): React.JSX.Element {
  const context = useNativeChatFileLinkContext(tabId)
  const worktreeId = context?.worktreeId
  const worktreePath = context?.worktreePath
  const runtimeEnvironmentId = context?.runtimeEnvironmentId ?? null
  const connectionId = useAppStore((s) =>
    worktreeId ? getConnectionIdFromState(s, worktreeId) : null
  )
  const existence = useMemo(
    () =>
      worktreeId && worktreePath
        ? createNativeChatFileLinkExistence({
            cwd: worktreePath,
            worktreeId,
            worktreePath,
            runtimeEnvironmentId,
            connectionId
          })
        : null,
    [connectionId, runtimeEnvironmentId, worktreeId, worktreePath]
  )
  useRecheckWhenHostReturns(existence, useFileLinkHostEpoch(connectionId, runtimeEnvironmentId))
  return (
    <NativeChatFileLinkExistenceContext.Provider value={existence}>
      {children}
    </NativeChatFileLinkExistenceContext.Provider>
  )
}

/** Undefined when this chat cannot open files, so nothing is underlined. */
export function useNativeChatFileLinkExists(
  enabled: boolean,
  streaming: boolean
): FileLinkExists | undefined {
  return useNativeChatFileLinkExistsFrom(
    useContext(NativeChatFileLinkExistenceContext),
    enabled,
    streaming
  )
}
