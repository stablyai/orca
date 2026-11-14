import { createContext, useMemo, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { resolveOwnerOrLocal } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { NativeChatFileLinkContext } from '../actions/native-chat-file-link-context'
import { useNativeChatGitHubRepo, type NativeChatGitHubRepo } from './native-chat-github-repo'
import { authorityKey, type HostAuthorityKey } from '../../../../../../shared/host-authority'

export type NativeChatLinkPeek = {
  githubRepo: NativeChatGitHubRepo | null
  /** The chat's host, where GitHub links off `githubRepo`'s hosts find a repo to answer them; null
   *  leaves those links to the web preview. */
  githubRoutingAuthorityKey: HostAuthorityKey | null
  /** Null while web link previews are turned off. */
  webPreviews: { runtimeEnvironmentId: string | null } | null
}

export const NativeChatLinkPeekContext = createContext<NativeChatLinkPeek>({
  githubRepo: null,
  githubRoutingAuthorityKey: null,
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
  const githubRoutingAuthorityKey = useAppStore((state) => {
    const match = fileLinkContext
      ? resolveOwnerOrLocal(state, { workspaceId: fileLinkContext.worktreeId })
      : null
    return match?.kind === 'resolved' ? authorityKey(match.owner) : null
  })
  const value = useMemo(
    () => ({
      githubRepo,
      githubRoutingAuthorityKey,
      webPreviews: webPreviewsEnabled ? { runtimeEnvironmentId } : null
    }),
    [githubRepo, githubRoutingAuthorityKey, runtimeEnvironmentId, webPreviewsEnabled]
  )
  return (
    <NativeChatLinkPeekContext.Provider value={value}>
      {children}
    </NativeChatLinkPeekContext.Provider>
  )
}
