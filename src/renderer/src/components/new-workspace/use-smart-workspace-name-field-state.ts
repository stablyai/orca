import { useRef, useState } from 'react'
import type { RepoSlug } from '@/lib/github-links'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import type { SmartNameMode } from './smart-workspace-source-results'
import type { MrStateFilter } from './smart-workspace-localized-options'
import type { CrossRepoPrompt } from './smart-workspace-name-field-model'

export function useSmartWorkspaceNameFieldState(textOnly: boolean, value: string) {
  const [mode, setMode] = useState<SmartNameMode>(textOnly ? 'text' : 'smart')
  const [mrStateFilter, setMrStateFilter] = useState<MrStateFilter>('opened')
  const [open, setOpen] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState(value)
  const [githubItems, setGithubItems] = useState<GitHubWorkItem[]>([])
  const [gitlabItems, setGitlabItems] = useState<GitLabWorkItem[]>([])
  const [branches, setBranches] = useState<BaseRefSearchResult[]>([])
  const [branchResultsSource, setBranchResultsSource] = useState<{
    repoId: string
    query: string
  } | null>(null)
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([])
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([])
  const [githubLoading, setGithubLoading] = useState(false)
  const [gitlabLoading, setGitlabLoading] = useState(false)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [linearLoading, setLinearLoading] = useState(false)
  const [linearUrlLoadingFeedbackQuery, setLinearUrlLoadingFeedbackQuery] = useState<string | null>(
    null
  )
  const [settledLinearUrlQuery, setSettledLinearUrlQuery] = useState<string | null>(null)
  const [jiraLoading, setJiraLoading] = useState(false)
  const [commandValue, setCommandValue] = useState('')
  const [emojiCommandValue, setEmojiCommandValue] = useState('')
  const [emojiCursor, setEmojiCursor] = useState<number | null>(null)
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const focusedSelectedSourceKeyRef = useRef<string | null>(null)
  const tabsListRef = useRef<HTMLDivElement | null>(null)
  const repoSlugCacheRef = useRef<Map<string, RepoSlug>>(new Map())
  const handledCrossRepoUrlRef = useRef<string | null>(null)
  const localInputFocusFrameRef = useRef<number | null>(null)
  // Why: Electron makes programmatic .focus() look user-initiated, so wait for real interaction.
  const deferSourcePopoverUntilInteractionRef = useRef(true)
  const [crossRepoPrompt, setCrossRepoPrompt] = useState<CrossRepoPrompt | null>(null)

  return {
    mode,
    setMode,
    mrStateFilter,
    setMrStateFilter,
    open,
    setOpen,
    debouncedQuery,
    setDebouncedQuery,
    githubItems,
    setGithubItems,
    gitlabItems,
    setGitlabItems,
    branches,
    setBranches,
    branchResultsSource,
    setBranchResultsSource,
    linearIssues,
    setLinearIssues,
    jiraIssues,
    setJiraIssues,
    githubLoading,
    setGithubLoading,
    gitlabLoading,
    setGitlabLoading,
    branchesLoading,
    setBranchesLoading,
    linearLoading,
    setLinearLoading,
    linearUrlLoadingFeedbackQuery,
    setLinearUrlLoadingFeedbackQuery,
    settledLinearUrlQuery,
    setSettledLinearUrlQuery,
    jiraLoading,
    setJiraLoading,
    commandValue,
    setCommandValue,
    emojiCommandValue,
    setEmojiCommandValue,
    emojiCursor,
    setEmojiCursor,
    localInputRef,
    focusedSelectedSourceKeyRef,
    tabsListRef,
    repoSlugCacheRef,
    handledCrossRepoUrlRef,
    localInputFocusFrameRef,
    deferSourcePopoverUntilInteractionRef,
    crossRepoPrompt,
    setCrossRepoPrompt
  }
}
