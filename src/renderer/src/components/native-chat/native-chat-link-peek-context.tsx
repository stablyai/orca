import { createContext, useMemo, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { useNativeChatGitHubRepo, type NativeChatGitHubRepo } from './native-chat-github-repo'

export type NativeChatLinkPeek = {
  githubRepo: NativeChatGitHubRepo | null
  /** Null while web link previews are turned off. */
  webPreviews: { runtimeEnvironmentId: string | null } | null
}

export const NativeChatLinkPeekContext = createContext<NativeChatLinkPeek>({
  githubRepo: null,
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
  const value = useMemo(
    () => ({
      githubRepo,
      webPreviews: webPreviewsEnabled ? { runtimeEnvironmentId } : null
    }),
    [githubRepo, runtimeEnvironmentId, webPreviewsEnabled]
  )
  return (
    <NativeChatLinkPeekContext.Provider value={value}>
      {children}
    </NativeChatLinkPeekContext.Provider>
  )
}
