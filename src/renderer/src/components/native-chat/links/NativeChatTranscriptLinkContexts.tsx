import type { ReactNode } from 'react'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnOpenedPullRequests } from '../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { NativeChatPullRequestChangeContext } from '../tools/pull-requests/NativeChatOpenedPullRequestCard'
import {
  NativeChatGitHubSeenReposContext,
  useNativeChatGitHubSeenRepos
} from './previews/native-chat-github-seen-repos'

/** What the whole transcript says about the links its rows render. */
export function NativeChatTranscriptLinkContexts({
  messages,
  pullRequests,
  children
}: {
  messages: readonly NativeChatMessage[]
  pullRequests: NativeChatTurnOpenedPullRequests
  children: ReactNode
}): React.JSX.Element {
  const seenRepos = useNativeChatGitHubSeenRepos(messages)
  return (
    <NativeChatPullRequestChangeContext.Provider value={pullRequests.latestChangeKey}>
      <NativeChatGitHubSeenReposContext.Provider value={seenRepos}>
        {children}
      </NativeChatGitHubSeenReposContext.Provider>
    </NativeChatPullRequestChangeContext.Provider>
  )
}
