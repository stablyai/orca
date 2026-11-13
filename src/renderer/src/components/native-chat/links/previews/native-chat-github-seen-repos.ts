import { createContext, useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  collectGitHubSeenReferenceRepos,
  type GitHubRepoReference,
  type GitHubSeenReferenceRepos
} from '../../../../../../shared/github/markdown/github-reference-links'
import {
  COMMAND_START,
  shellCode
} from '../../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { nativeChatToolCallScript } from '../../../../../../shared/native-chat/tools/native-chat-tool-call-script'
import { pairToolBlocks } from '../../../../../../shared/native-chat/tools/native-chat-tool-pairs'

const NO_SEEN_REPOS: GitHubSeenReferenceRepos = new Map()
// Only gh output speaks for this chat's references; a read file or fetched page may cite any repo.
const RUNS_GH = new RegExp(`${COMMAND_START}gh\\s`, 'u')

/** Repos bare `#123` in this chat's messages follow ahead of the chat's own repo. */
export const NativeChatGitHubSeenReposContext =
  createContext<GitHubSeenReferenceRepos>(NO_SEEN_REPOS)

// A message's blocks never change once written, so a streaming reply rescans only its new rows.
const seenByMessage = new WeakMap<NativeChatMessage, GitHubSeenReferenceRepos>()

function messageSeenRepos(message: NativeChatMessage): GitHubSeenReferenceRepos {
  let seen = seenByMessage.get(message)
  if (!seen) {
    const found = new Map<string, GitHubRepoReference>()
    for (const block of message.blocks) {
      if (block.type === 'text') {
        collectGitHubSeenReferenceRepos(block.text, found)
      }
    }
    for (const { call, result } of pairToolBlocks(message.blocks)) {
      const script = call && result ? nativeChatToolCallScript(call.name, call.input) : null
      if (result && script && RUNS_GH.test(shellCode(script))) {
        collectGitHubSeenReferenceRepos(result.output, found)
      }
    }
    seen = found.size > 0 ? found : NO_SEEN_REPOS
    seenByMessage.set(message, seen)
  }
  return seen
}

/** github.com issue and PR URLs the transcript printed, by number; the latest one wins. */
export function nativeChatGitHubSeenRepos(
  messages: readonly NativeChatMessage[]
): GitHubSeenReferenceRepos {
  const seen = new Map<string, GitHubRepoReference>()
  for (const message of messages) {
    for (const [number, repo] of messageSeenRepos(message)) {
      seen.delete(number)
      seen.set(number, repo)
    }
  }
  return seen.size > 0 ? seen : NO_SEEN_REPOS
}

/** Stable until a new URL changes where a number points, so markdown is not re-parsed per update. */
export function useNativeChatGitHubSeenRepos(
  messages: readonly NativeChatMessage[]
): GitHubSeenReferenceRepos {
  // URL path segments never hold whitespace, so a space-separated key round-trips.
  const key = useMemo(
    () =>
      [...nativeChatGitHubSeenRepos(messages)]
        .map(([number, { owner, repo }]) => `${number} ${owner} ${repo}`)
        .join('\n'),
    [messages]
  )
  return useMemo(() => {
    if (!key) {
      return NO_SEEN_REPOS
    }
    const seen = new Map<string, GitHubRepoReference>()
    for (const line of key.split('\n')) {
      const [number = '', owner = '', repo = ''] = line.split(' ')
      seen.set(number, { owner, repo })
    }
    return seen
  }, [key])
}
