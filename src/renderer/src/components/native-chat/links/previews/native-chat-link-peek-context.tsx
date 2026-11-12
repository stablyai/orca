import { createContext, useMemo, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import type { NativeChatFileLinkContext } from '../actions/native-chat-file-link-context'
import { useNativeChatGitHubRepo, type NativeChatGitHubRepo } from './native-chat-github-repo'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'

export type NativeChatLinkPeek = {
  githubRepo: NativeChatGitHubRepo | null
  /** The chat's host, where GitHub links off `githubRepo`'s hosts find a repo to answer them; null
   *  leaves those links to the web preview. */
  githubRoutingHostId: string | null
  /** Null while web link previews are turned off. */
  webPreviews: { runtimeEnvironmentId: string | null } | null
}

export const NativeChatLinkPeekContext = createContext<NativeChatLinkPeek>({
  githubRepo: null,
  githubRoutingHostId: null,
  webPreviews: null
})

/** Resolved once per chat; every message's links read it. */
export function NativeChatLinkPeekProvider({
  fileLinkContext,
  children
}: {
  fileLinkContext: NativeChatFileLinkContext | null
  children: ReactNode
}): React.JSX.Element {
  const githubRepo = useNativeChatGitHubRepo(fileLinkContext?.worktreeId)
  const webPreviewsEnabled = useAppStore(
    (state) => state.settings?.nativeChatLinkPreviews !== false
  )
  const runtimeEnvironmentId = fileLinkContext?.runtimeEnvironmentId ?? null
  // Like web previews, a chat on a runtime environment asks that host; any other chat asks this one.
  const githubRoutingHostId = fileLinkContext
    ? runtimeEnvironmentId
      ? toRuntimeExecutionHostId(runtimeEnvironmentId)
      : LOCAL_EXECUTION_HOST_ID
    : null
  const value = useMemo(
    () => ({
      githubRepo,
      githubRoutingHostId,
      webPreviews: webPreviewsEnabled ? { runtimeEnvironmentId } : null
    }),
    [githubRepo, githubRoutingHostId, runtimeEnvironmentId, webPreviewsEnabled]
  )
  return (
    <NativeChatLinkPeekContext.Provider value={value}>
      {children}
    </NativeChatLinkPeekContext.Provider>
  )
}
