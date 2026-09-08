import type { ComposerModel } from './composer-model'

type LinkedItemLookupEffectsInput = Pick<
  ComposerModel,
  | 'baseBranch'
  | 'linkPopoverOpen'
  | 'linkQuery'
  | 'normalizedLinkQuery'
  | 'prefetchWorkItems'
  | 'prefetchWorktreeCreateBase'
  | 'repoId'
  | 'selectedRepo'
  | 'selectedRepoConnectionId'
  | 'selectedRepoGitHubSourceContext'
  | 'selectedRepoIsGit'
  | 'selectedRepoSshStatus'
  | 'setLinkDebouncedQuery'
  | 'setLinkDirectItem'
  | 'setLinkDirectLoading'
  | 'setLinkItems'
  | 'setLinkItemsLoading'
  | 'setSetupDecision'
  | 'setupConfig'
  | 'setupPolicy'
  | 'shouldWaitForSetupCheck'
  | 'sshConnectedGeneration'
>

import { canUseRepoBackedComposerSources } from '@/lib/new-workspace-ssh-gate'
import { useEffect } from 'react'
import { PER_REPO_FETCH_LIMIT } from '@/lib/new-workspace'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import {
  lookupGitHubWorkItemByOwnerRepoForSource,
  lookupGitHubWorkItemForSource
} from '@/lib/github-work-item-source-lookup'

export function useLinkedItemLookupEffects(input: LinkedItemLookupEffectsInput) {
  const {
    baseBranch,
    linkPopoverOpen,
    linkQuery,
    normalizedLinkQuery,
    prefetchWorkItems,
    prefetchWorktreeCreateBase,
    repoId,
    selectedRepo,
    selectedRepoConnectionId,
    selectedRepoGitHubSourceContext,
    selectedRepoIsGit,
    selectedRepoSshStatus,
    setLinkDebouncedQuery,
    setLinkDirectItem,
    setLinkDirectLoading,
    setLinkItems,
    setLinkItemsLoading,
    setSetupDecision,
    setupConfig,
    setupPolicy,
    shouldWaitForSetupCheck,
    sshConnectedGeneration
  } = input

  // Why: warm the Start-from picker's PR cache so opening it paints instantly from cache.
  const canPrefetchSelectedRepoWorkItems = canUseRepoBackedComposerSources({
    connectionId: selectedRepoConnectionId,
    status: selectedRepoSshStatus
  })

  const prefetchSshConnectedGeneration =
    selectedRepoConnectionId && selectedRepoSshStatus === 'connected' ? sshConnectedGeneration : 0

  useEffect(() => {
    if (!repoId || !selectedRepoIsGit || !canPrefetchSelectedRepoWorkItems) {
      return
    }
    void prefetchWorktreeCreateBase(repoId, baseBranch)
  }, [
    baseBranch,
    canPrefetchSelectedRepoWorkItems,
    prefetchSshConnectedGeneration,
    prefetchWorktreeCreateBase,
    repoId,
    selectedRepoIsGit
  ])

  useEffect(() => {
    if (!selectedRepoIsGit || !selectedRepo?.path || !canPrefetchSelectedRepoWorkItems) {
      return
    }
    prefetchWorkItems(selectedRepo.id, selectedRepo.path, PER_REPO_FETCH_LIMIT, 'is:pr is:open')
  }, [
    canPrefetchSelectedRepoWorkItems,
    prefetchSshConnectedGeneration,
    prefetchWorkItems,
    selectedRepo?.id,
    selectedRepo?.path,
    selectedRepoIsGit
  ])

  // Reset setup decision when config / policy changes.
  useEffect(() => {
    if (shouldWaitForSetupCheck) {
      setSetupDecision(null)
      return
    }
    if (!setupConfig) {
      setSetupDecision(null)
      return
    }
    if (setupPolicy === 'ask') {
      setSetupDecision(null)
      return
    }
    setSetupDecision(setupPolicy === 'run-by-default' ? 'run' : 'skip')
  }, [setupConfig, setupPolicy, shouldWaitForSetupCheck, setSetupDecision])

  // Link popover: debounce + load recent items + resolve direct number.
  useEffect(() => {
    const timeout = window.setTimeout(() => setLinkDebouncedQuery(linkQuery), 250)
    return () => window.clearTimeout(timeout)
  }, [linkQuery, setLinkDebouncedQuery])

  useEffect(() => {
    if (!linkPopoverOpen || !selectedRepo || !selectedRepoIsGit) {
      return
    }

    let cancelled = false
    setLinkItemsLoading(true)

    const lookupRepoId = selectedRepo.id
    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, repoId: selectedRepo.id, limit: 100 })
      .then((envelope) => {
        if (!cancelled) {
          // Why: IPC omits repoId — stamp it from the queried repo below; cast through unknown since spreading the discriminated union loses the discriminant.
          // Why: the @-mention popover deliberately shows no error banner (it would crowd the input and the user sees it on the Tasks page); log to devtools instead.
          if (envelope.errors?.issues) {
            console.warn(
              '[composer/link] issues-side partial failure in @-mention popover:',
              envelope.errors.issues
            )
          }
          setLinkItems(
            envelope.items.map((it) => ({
              ...it,
              repoId: lookupRepoId
            })) as unknown as GitHubWorkItem[]
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkItems([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkItemsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [linkPopoverOpen, selectedRepo, selectedRepoIsGit, setLinkItems, setLinkItemsLoading])

  useEffect(() => {
    if (
      !linkPopoverOpen ||
      !selectedRepo ||
      !selectedRepoIsGit ||
      normalizedLinkQuery.directNumber === null
    ) {
      setLinkDirectItem(null)
      setLinkDirectLoading(false)
      return
    }

    let cancelled = false
    setLinkDirectLoading(true)
    // Why: a full URL carries issue-vs-PR intent, so preserve the URL route instead of probing by number only.
    const lookupRepoId = selectedRepo.id
    const lookup =
      normalizedLinkQuery.directLink !== undefined
        ? lookupGitHubWorkItemByOwnerRepoForSource({
            repoPath: selectedRepo.path,
            repoId: selectedRepo.id,
            sourceContext: selectedRepoGitHubSourceContext,
            owner: normalizedLinkQuery.directLink.slug.owner,
            repo: normalizedLinkQuery.directLink.slug.repo,
            ...(normalizedLinkQuery.directLink.slug.host
              ? { host: normalizedLinkQuery.directLink.slug.host }
              : {}),
            number: normalizedLinkQuery.directLink.number,
            type: normalizedLinkQuery.directLink.type
          })
        : lookupGitHubWorkItemForSource({
            repoPath: selectedRepo.path,
            repoId: selectedRepo.id,
            sourceContext: selectedRepoGitHubSourceContext,
            number: normalizedLinkQuery.directNumber
          })
    void lookup
      .then((item) => {
        if (!cancelled) {
          setLinkDirectItem(
            item ? ({ ...item, repoId: lookupRepoId } as unknown as GitHubWorkItem) : null
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkDirectItem(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkDirectLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    normalizedLinkQuery.directLink,
    linkPopoverOpen,
    normalizedLinkQuery.directNumber,
    selectedRepo,
    selectedRepoGitHubSourceContext,
    selectedRepoIsGit,
    setLinkDirectItem,
    setLinkDirectLoading
  ])

  return {
    canPrefetchSelectedRepoWorkItems,
    prefetchSshConnectedGeneration
  }
}
