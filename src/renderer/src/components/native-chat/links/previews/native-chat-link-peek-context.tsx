import { createContext, useMemo, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import type { NativeChatFileLinkContext } from '../actions/native-chat-file-link-context'
import {
  useNativeChatGitHubRepo,
  useNativeChatLookupRepo,
  type NativeChatGitHubRepo
} from './native-chat-github-repo'
import { useNativeChatIssueKeys } from './native-chat-issue-keys'
import { trustedGitLabHosts } from './native-chat-tracker-links'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { IssueKeyReferences } from '../../../../../../shared/work-items/issue-key-reference-links'
import type { JiraSite } from '../../../../../../shared/jira/jira-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  nativeChatReferenceChipMode,
  type NativeChatReferenceChipMode
} from '../../../../../../shared/native-chat/native-chat-reference-chips'

export type NativeChatLinkPeek = {
  githubRepo: NativeChatGitHubRepo | null
  /** Null while web link previews are turned off. */
  webPreviews: { runtimeEnvironmentId: string | null } | null
  /** Linear team and Jira project keys; `KEY-123` in replies links only for these. */
  issueKeys: IssueKeyReferences
  linearConnected: boolean
  /** Jira sites connected on the chat's host, so a `/browse/KEY-1` link previews only on a site it can read. */
  jiraSites: readonly JiraSite[]
  /** The chat's host; Jira previews are read through its connection. */
  trackerHostId: ExecutionHostId
  /** Sends GitLab lookups; null when the chat's host has no git repo. */
  gitLabLookupRepo: Repo | null
  /** Hosts a GitLab link may be looked up on. */
  gitLabHosts: ReadonlySet<string>
  /** How links that only repeat an issue or PR ID show. */
  referenceChips: NativeChatReferenceChipMode
}

const NO_SITES: readonly JiraSite[] = []
const NO_HOSTS: ReadonlySet<string> = new Set()

export const NativeChatLinkPeekContext = createContext<NativeChatLinkPeek>({
  githubRepo: null,
  webPreviews: null,
  issueKeys: new Map(),
  linearConnected: false,
  jiraSites: NO_SITES,
  trackerHostId: LOCAL_EXECUTION_HOST_ID,
  gitLabLookupRepo: null,
  gitLabHosts: NO_HOSTS,
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
  const { issueKeys, jiraSites } = useNativeChatIssueKeys(runtimeEnvironmentId)
  const linearConnected = useAppStore((state) => state.linearStatus.connected)
  const repos = useAppStore((state) => state.repos)
  const gitLabHosts = useMemo(() => trustedGitLabHosts(repos), [repos])
  const trackerHostId: ExecutionHostId = runtimeEnvironmentId
    ? toRuntimeExecutionHostId(runtimeEnvironmentId)
    : LOCAL_EXECUTION_HOST_ID
  const webPreviewsEnabled = useAppStore(
    (state) => state.settings?.nativeChatLinkPreviews !== false
  )
  const referenceChips = useAppStore((state) => nativeChatReferenceChipMode(state.settings))
  const value = useMemo<NativeChatLinkPeek>(
    () => ({
      githubRepo,
      webPreviews: webPreviewsEnabled ? { runtimeEnvironmentId } : null,
      issueKeys,
      linearConnected,
      jiraSites,
      trackerHostId,
      gitLabLookupRepo,
      gitLabHosts,
      referenceChips
    }),
    [
      githubRepo,
      gitLabLookupRepo,
      gitLabHosts,
      issueKeys,
      jiraSites,
      linearConnected,
      referenceChips,
      runtimeEnvironmentId,
      trackerHostId,
      webPreviewsEnabled
    ]
  )
  return (
    <NativeChatLinkPeekContext.Provider value={value}>
      {children}
    </NativeChatLinkPeekContext.Provider>
  )
}
