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
  getLinkedWorkItemProvider,
  canUseIssueCommandForLinkedItemProvider,
  getWorkspaceSeedName,
  DEFAULT_ISSUE_COMMAND_TEMPLATE,
  renderIssueCommandTemplate
} from '@/lib/new-workspace'
import type { SetupRunPolicy } from '../../../../shared/orca-yaml-hook-types'
import { getDefaultSetupDecision, getSetupConfig } from '../../../../shared/orca-hook-setup-config'
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

  // Edited directory selections become Custom; retain preset attribution only while paths still match.
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

  // Recover pasted PR numbers when no picker populated linkedPR.
  const effectiveLinkedPR = useMemo<number | null>(() => {
    if (linkedPR !== null) {
      return linkedPR
    }
    const fromName = parseGitHubIssueOrPRLink(name)
    if (fromName && fromName.type === 'pr') {
      // Require the resolved selected-repo slug to match, preventing links to a foreign same-numbered PR.
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

  const requiresExplicitSetupChoice = Boolean(setupConfig) && setupPolicy === 'ask'

  const resolvedSetupDecision =
    setupDecision ?? getDefaultSetupDecision(Boolean(setupConfig), setupPolicy)

  const isSetupCheckPending =
    selectedRepoIsGit &&
    Boolean(selectedRepoHookContextKey) &&
    checkedHooksContextKey !== selectedRepoHookContextKey

  const shouldWaitForSetupCheck = Boolean(selectedRepo) && selectedRepoIsGit && isSetupCheckPending

  // Blank unseeded names need globally unique creature names; exclude retired paths too.
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
