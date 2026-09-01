import type { DerivedComposerStateInput } from './composer-target-input-contracts'

import { useMemo } from 'react'
import { normalizeSparseDirectoryLines, sparseDirectoriesMatch } from '@/lib/sparse-paths'
import {
  parseGitHubIssueOrPRNumber,
  parseGitHubIssueOrPRLink,
  normalizeGitHubLinkQuery
} from '@/lib/github-links'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  getSetupConfig,
  getLinkedWorkItemProvider,
  canUseIssueCommandForLinkedItemProvider,
  getWorkspaceSeedName,
  DEFAULT_ISSUE_COMMAND_TEMPLATE,
  renderIssueCommandTemplate
} from '@/lib/new-workspace'
import type { SetupRunPolicy } from '../../../../shared/orca-yaml-hook-types'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import { useRetiredWorktreeNames } from '@/hooks/useRetiredWorktreeNames'
import { getSuggestedCreatureName } from '@/components/sidebar/worktree-name-suggestions'
const EMPTY_SPARSE_PRESETS: SparsePreset[] = []

export function useDerivedComposerState(input: DerivedComposerStateInput) {
  const {
    agentPrompt,
    checkedHooksContextKey,
    enableIssueAutomation,
    hasLoadedIssueCommand,
    issueCommandTemplate,
    linkDebouncedQuery,
    linkDirectItem,
    linkItems,
    linkedIssue,
    linkedPR,
    linkedWorkItem,
    name,
    repoId,
    selectedRepo,
    selectedRepoHookContextKey,
    selectedRepoIsGit,
    selectedRepoSlug,
    setupDecision,
    sparseDirectories,
    sparseEnabled,
    sparsePresetsByRepo,
    sparseSelectedPresetId,
    worktreesByRepo,
    yamlHooks
  } = input

  const sparsePresetsForRepo = sparsePresetsByRepo[repoId]

  const sparsePresets = sparsePresetsForRepo ?? EMPTY_SPARSE_PRESETS

  const normalizedSparseDirectories = useMemo(
    () => normalizeSparseDirectoryLines(sparseDirectories),
    [sparseDirectories]
  )

  // Why: only attribute the preset if the directories still match it; an edited selection is "Custom", not falsely tagged as the original preset.
  const effectivePresetId = useMemo(() => {
    if (!sparseSelectedPresetId) {
      return null
    }
    const selected = sparsePresets.find((preset) => preset.id === sparseSelectedPresetId)
    if (!selected) {
      return null
    }
    return sparseDirectoriesMatch(selected.directories, normalizedSparseDirectories)
      ? selected.id
      : null
  }, [normalizedSparseDirectories, sparsePresets, sparseSelectedPresetId])

  const sparseError = useMemo(() => {
    if (!sparseEnabled) {
      return null
    }
    if (!selectedRepoIsGit) {
      return null
    }
    if (selectedRepo?.connectionId) {
      return 'Sparse checkout is only supported for local repos right now.'
    }
    if (normalizedSparseDirectories.length === 0) {
      return 'Enter at least one repo-relative directory.'
    }
    if (
      normalizedSparseDirectories.some((entry) => entry === '.' || entry.split('/').includes('..'))
    ) {
      return 'Use repo-relative directories, not root or parent paths.'
    }
    return null
  }, [normalizedSparseDirectories, selectedRepo?.connectionId, selectedRepoIsGit, sparseEnabled])

  const parsedLinkedIssueNumber = useMemo(
    () => (linkedIssue.trim() ? parseGitHubIssueOrPRNumber(linkedIssue) : null),
    [linkedIssue]
  )

  // Why: a PR URL pasted into the name field (not picked) leaves linkedPR null; recover the number so the worktree still links back to its PR.
  const effectiveLinkedPR = useMemo<number | null>(() => {
    if (linkedPR !== null) {
      return linkedPR
    }
    const fromName = parseGitHubIssueOrPRLink(name)
    if (fromName && fromName.type === 'pr') {
      // Why: adopt the number only when the URL slug matches the selected repo (and the slug has resolved), else a foreign PR URL mislinks to a same-numbered PR here.
      if (
        selectedRepoSlug &&
        githubRepoIdentityKey(fromName.slug) === githubRepoIdentityKey(selectedRepoSlug)
      ) {
        return fromName.number
      }
    }
    return null
  }, [linkedPR, name, selectedRepoSlug])

  const currentYamlHooks = checkedHooksContextKey === selectedRepoHookContextKey ? yamlHooks : null

  const setupConfig = useMemo(
    () => (selectedRepoIsGit ? getSetupConfig(selectedRepo, currentYamlHooks) : null),
    [currentYamlHooks, selectedRepo, selectedRepoIsGit]
  )

  const setupPolicy: SetupRunPolicy = selectedRepo?.hookSettings?.setupRunPolicy ?? 'run-by-default'

  const linkedWorkItemProvider = linkedWorkItem ? getLinkedWorkItemProvider(linkedWorkItem) : null

  // Why: sentinel-based Jira/Linear items must bypass repository issue templates.
  const willApplyIssueCommandAsPrompt =
    enableIssueAutomation &&
    !agentPrompt.trim() &&
    Boolean(linkedWorkItem) &&
    canUseIssueCommandForLinkedItemProvider(linkedWorkItemProvider)

  const shouldWaitForIssueAutomationCheck =
    enableIssueAutomation &&
    (parsedLinkedIssueNumber !== null || willApplyIssueCommandAsPrompt) &&
    !hasLoadedIssueCommand

  const requiresExplicitSetupChoice = Boolean(setupConfig) && setupPolicy === 'ask'

  const resolvedSetupDecision =
    setupDecision ??
    (!setupConfig || setupPolicy === 'ask'
      ? null
      : setupPolicy === 'run-by-default'
        ? 'run'
        : 'skip')

  const isSetupCheckPending =
    selectedRepoIsGit &&
    Boolean(selectedRepoHookContextKey) &&
    checkedHooksContextKey !== selectedRepoHookContextKey

  const shouldWaitForSetupCheck = Boolean(selectedRepo) && selectedRepoIsGit && isSetupCheckPending

  // Why: blank name with no other seed → globally-unique creature name so workspaces don't collide across repos or on a literal default.
  // Retired names are excluded too, so a recreated workspace never reuses a deleted one's path.
  const retiredNamesRefreshKey = useMemo(
    () =>
      (worktreesByRepo[repoId] ?? [])
        .map((worktree) => worktree.path)
        .sort()
        .join('\0'),
    [repoId, worktreesByRepo]
  )

  const retiredWorktreeNames = useRetiredWorktreeNames(repoId, retiredNamesRefreshKey)

  const fallbackCreatureName = useMemo(
    () => getSuggestedCreatureName(worktreesByRepo, undefined, retiredWorktreeNames),
    [worktreesByRepo, retiredWorktreeNames]
  )

  const workspaceSeedName = useMemo(
    () =>
      getWorkspaceSeedName({
        explicitName: name,
        prompt: agentPrompt,
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR,
        fallbackName: fallbackCreatureName
      }),
    [agentPrompt, fallbackCreatureName, linkedPR, name, parsedLinkedIssueNumber]
  )

  // Why: Jira/Linear use sentinel numbers that are invalid in legacy {{issue}} templates.
  const shouldApplyLinkedOnlyTemplate =
    enableIssueAutomation &&
    !agentPrompt.trim() &&
    Boolean(linkedWorkItem) &&
    hasLoadedIssueCommand &&
    canUseIssueCommandForLinkedItemProvider(linkedWorkItemProvider)

  const linkedOnlyTemplatePrompt = useMemo(() => {
    if (!shouldApplyLinkedOnlyTemplate || !linkedWorkItem) {
      return ''
    }
    const template = issueCommandTemplate.trim() || DEFAULT_ISSUE_COMMAND_TEMPLATE
    return renderIssueCommandTemplate(template, {
      issueNumber: linkedWorkItem.type === 'issue' ? linkedWorkItem.number : null,
      artifactUrl: linkedWorkItem.url
    })
  }, [issueCommandTemplate, linkedWorkItem, shouldApplyLinkedOnlyTemplate])

  const normalizedLinkQuery = useMemo(
    () => normalizeGitHubLinkQuery(linkDebouncedQuery),
    [linkDebouncedQuery]
  )

  const filteredLinkItems = useMemo(() => {
    if (normalizedLinkQuery.tooLarge) {
      return []
    }
    if (normalizedLinkQuery.directNumber !== null) {
      return linkDirectItem ? [linkDirectItem] : []
    }

    const query = normalizedLinkQuery.query.trim().toLowerCase()
    if (!query) {
      return linkItems
    }

    return linkItems.filter((item) => {
      const text = [
        item.type,
        item.number,
        item.title,
        item.author ?? '',
        item.labels.join(' '),
        item.branchName ?? '',
        item.baseRefName ?? ''
      ]
        .join(' ')
        .toLowerCase()
      return text.includes(query)
    })
  }, [
    linkDirectItem,
    linkItems,
    normalizedLinkQuery.directNumber,
    normalizedLinkQuery.query,
    normalizedLinkQuery.tooLarge
  ])

  return {
    sparsePresetsForRepo,
    sparsePresets,
    normalizedSparseDirectories,
    effectivePresetId,
    sparseError,
    parsedLinkedIssueNumber,
    effectiveLinkedPR,
    currentYamlHooks,
    setupConfig,
    setupPolicy,
    linkedWorkItemProvider,
    willApplyIssueCommandAsPrompt,
    shouldWaitForIssueAutomationCheck,
    requiresExplicitSetupChoice,
    resolvedSetupDecision,
    isSetupCheckPending,
    shouldWaitForSetupCheck,
    retiredNamesRefreshKey,
    retiredWorktreeNames,
    fallbackCreatureName,
    workspaceSeedName,
    shouldApplyLinkedOnlyTemplate,
    linkedOnlyTemplatePrompt,
    normalizedLinkQuery,
    filteredLinkItems
  }
}
