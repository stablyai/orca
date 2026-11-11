import { createContext, useMemo, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import type { NativeChatFileLinkContext } from '../actions/native-chat-file-link-context'
import {
  useNativeChatGitHubRepo,
  useNativeChatLookupRepo,
  type NativeChatGitHubRepo
} from './native-chat-github-repo'
import { useNativeChatIssueKeys } from './native-chat-issue-keys'
import type { IssueKeyReferences } from '../../../../../../shared/work-items/issue-key-reference-links'
import type { NativeChatReferenceChipMode } from '../../../../../../shared/global-settings-types'
import type { JiraSite } from '../../../../../../shared/jira/jira-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { nativeChatReferenceChipMode } from '../../../../../../shared/native-chat/native-chat-reference-chips'

export type NativeChatLinkPeek = {
  githubRepo: NativeChatGitHubRepo | null
  /** Null while web link previews are turned off. */
  webPreviews: { runtimeEnvironmentId: string | null } | null
  /** Linear team and Jira project keys; `KEY-123` in replies links only for these. */
  issueKeys: IssueKeyReferences
  linearConnected: boolean
  /** Connected Jira sites, so a `/browse/KEY-1` link previews only on a site Orca can read. */
  jiraSites: readonly JiraSite[]
  /** Sends GitLab lookups; null when this host has no local repo. */
  gitLabLookupRepo: Repo | null
  /** How links that only repeat an issue or PR ID show. */
  referenceChips: NativeChatReferenceChipMode
}

const NO_SITES: readonly JiraSite[] = []

export const NativeChatLinkPeekContext = createContext<NativeChatLinkPeek>({
  githubRepo: null,
  webPreviews: null,
  issueKeys: new Map(),
  linearConnected: false,
  jiraSites: NO_SITES,
  gitLabLookupRepo: null,
  referenceChips: 'full'
})

/** Resolved once per chat; every message's links read it. */
export function NativeChatLinkPeekProvider({
  fileLinkContext,
  children
}: {
  fileLinkContext: NativeChatFileLinkContext | null
  children: ReactNode
}): React.JSX.Element {
  const runtimeEnvironmentId = fileLinkContext?.runtimeEnvironmentId ?? null
  const githubRepo = useNativeChatGitHubRepo(fileLinkContext?.worktreeId)
  const gitLabLookupRepo = useNativeChatLookupRepo(fileLinkContext?.worktreeId)
  const issueKeys = useNativeChatIssueKeys(runtimeEnvironmentId)
  const linearConnected = useAppStore((state) => state.linearStatus.connected)
  const jiraConnected = useAppStore((state) => state.jiraStatus.connected)
  const jiraSites = useAppStore((state) => state.jiraStatus.sites)
  const webPreviewsEnabled = useAppStore(
    (state) => state.settings?.nativeChatLinkPreviews !== false
  )
  const referenceChips = useAppStore((state) => nativeChatReferenceChipMode(state.settings))
  const value = useMemo(
    () => ({
      githubRepo,
      webPreviews: webPreviewsEnabled ? { runtimeEnvironmentId } : null,
      issueKeys,
      linearConnected,
      jiraSites: jiraConnected && jiraSites ? jiraSites : NO_SITES,
      gitLabLookupRepo,
      referenceChips
    }),
    [
      githubRepo,
      gitLabLookupRepo,
      issueKeys,
      jiraConnected,
      jiraSites,
      linearConnected,
      referenceChips,
      runtimeEnvironmentId,
      webPreviewsEnabled
    ]
  )
  return (
    <NativeChatLinkPeekContext.Provider value={value}>
      {children}
    </NativeChatLinkPeekContext.Provider>
  )
}
