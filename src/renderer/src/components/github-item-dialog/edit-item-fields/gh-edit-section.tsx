import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useRepoLabels, useRepoAssignees, useImmediateMutation } from '@/hooks/useIssueMetadata'
import { useRepoLabelsBySlug, useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import { getTaskSourceRuntimeSettings } from '../../../../../shared/task-source-context'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import {
  getTaskPageGitHubDuplicateCandidates,
  getTaskPageGitHubDuplicateTargetErrorMessage,
  validateTaskPageGitHubDuplicateTarget,
  type TaskPageGitHubCloseAction
} from '@/components/task-page-github-status-actions'
import { parseOwnerRepoFromItemUrl } from '@/components/github/github-work-item-identity'
import { translate } from '@/i18n/i18n'
import type { GitHubItemDialogEditSectionProps } from '../load-item-details/github-item-dialog-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getGitHubRepositoryLabelsUrl } from './repository-labels-url'
import {
  closeGHEditAsDuplicate,
  runGHEditAssigneeToggle,
  runGHEditLabelToggle,
  runGHEditStateChange
} from './gh-edit-section-mutations'
import { GHEditSectionTopColumns } from './gh-edit-section-top-columns'
import { GHEditSectionHorizontal } from './gh-edit-section-horizontal'
import { useGitHubDuplicateIssueCandidates } from '@/components/github/github-duplicate-issue-candidates'

export function GHEditSection(props: GitHubItemDialogEditSectionProps): React.JSX.Element | null {
  const { item, projectOrigin } = props
  const repository = projectOrigin ?? parseOwnerRepoFromItemUrl(item.url)
  const itemKey = `${item.repoId}\0${repository ? githubRepoIdentityKey(repository) : item.url}\0${item.type}\0${item.id}`
  return <GHEditSectionItem key={itemKey} {...props} />
}

function GHEditSectionItem({
  item,
  repoPath,
  repoId,
  sourceContext,
  projectOrigin,
  localState,
  localLabels,
  onStateChange,
  onLabelsChange,
  onMutated,
  assignees,
  onUse,
  onOpenOrUse,
  attachedWorkspaceLabel,
  layout = 'horizontal'
}: GitHubItemDialogEditSectionProps): React.JSX.Element | null {
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false)
  const [assigneePopoverOpen, setAssigneePopoverOpen] = useState(false)
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false)
  const [duplicatePickerOpen, setDuplicatePickerOpen] = useState(false)
  const [duplicateSearch, setDuplicateSearch] = useState('')
  const [duplicateError, setDuplicateError] = useState<string | null>(null)
  const [localAssignees, setLocalAssignees] = useState<string[]>(assignees)
  const editedAssigneesItemKeyRef = useRef<string | null>(null)
  const mountedRef = useMountedRef()
  const assigneesItemKey = `${item.repoId}\0${item.id}`
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const patchProjectRowContent = useAppStore((s) => s.patchProjectRowContent)
  const duplicateIssueCandidates = useGitHubDuplicateIssueCandidates(item, duplicatePickerOpen)
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, item.repoId ?? null))
  )
  const sourceSettings = useMemo(
    () =>
      sourceContext?.provider === 'github'
        ? ({
            ...repoOwnerSettings,
            ...getTaskSourceRuntimeSettings(sourceContext)
          } as typeof repoOwnerSettings)
        : repoOwnerSettings,
    [repoOwnerSettings, sourceContext]
  )
  const { isPending, run } = useImmediateMutation()
  // Why: from a Project view, keep projectViewCache in sync too — patchWorkItem only walks workItemsCache, so the table would render stale without this. See docs/design/github-project-view-tasks.md §Dialog editing from Project rows.
  const patchProjectRowIfNeeded = useCallback(
    (patch: Parameters<typeof patchProjectRowContent>[2]) => {
      if (!projectOrigin) {
        return
      }
      patchProjectRowContent(projectOrigin.cacheKey, projectOrigin.projectItemId, patch)
    },
    [projectOrigin, patchProjectRowContent]
  )

  const issueRepo = useMemo(() => parseOwnerRepoFromItemUrl(item.url), [item.url])
  const metadataOptions = useMemo(
    () => ({ ...sourceSettings, ownerRepo: issueRepo }),
    [sourceSettings, issueRepo]
  )
  // Project metadata comes from the row repository.
  const slugOwner = projectOrigin?.owner ?? null
  const slugRepo = projectOrigin?.repo ?? null
  const repoLabelsByPath = useRepoLabels(
    projectOrigin ? null : repoPath,
    projectOrigin ? null : repoId,
    metadataOptions
  )
  const repoLabelsBySlug = useRepoLabelsBySlug(
    slugOwner,
    slugRepo,
    sourceSettings,
    projectOrigin?.host
  )
  const repoLabels = projectOrigin ? repoLabelsBySlug : repoLabelsByPath
  const repositoryLabelsUrl = useMemo(() => getGitHubRepositoryLabelsUrl(item.url), [item.url])
  const repoAssigneesByPath = useRepoAssignees(
    projectOrigin ? null : repoPath,
    projectOrigin ? null : repoId,
    metadataOptions
  )
  const repoAssigneesBySlug = useRepoAssigneesBySlug(
    slugOwner,
    slugRepo,
    assignees,
    sourceSettings,
    projectOrigin?.host
  )
  const repoAssignees = projectOrigin ? repoAssigneesBySlug : repoAssigneesByPath
  const hasAttachedWorkspace =
    attachedWorkspaceLabel !== null && attachedWorkspaceLabel !== undefined
  const filteredDuplicateCandidates = useMemo(
    () =>
      getTaskPageGitHubDuplicateCandidates(duplicateIssueCandidates, item.number, duplicateSearch),
    [duplicateIssueCandidates, duplicateSearch, item.number]
  )
  const directDuplicateTarget = useMemo(() => {
    const trimmed = duplicateSearch.trim()
    const validation = validateTaskPageGitHubDuplicateTarget(trimmed, item.number)
    if (!trimmed || !validation.ok) {
      return null
    }
    if (
      filteredDuplicateCandidates.some((candidate) => candidate.number === validation.duplicateOf)
    ) {
      return null
    }
    return validation.duplicateOf
  }, [duplicateSearch, filteredDuplicateCandidates, item.number])
  const duplicatePickerTitle = useMemo(() => {
    if (projectOrigin) {
      return `${projectOrigin.owner}/${projectOrigin.repo}`
    }
    const parsed = parseOwnerRepoFromItemUrl(item.url)
    return parsed
      ? `${parsed.owner}/${parsed.repo}`
      : translate('auto.components.TaskPage.repository', 'Repository')
  }, [item.url, projectOrigin])
  const handleOpenOrUseWorkspace = useCallback((): void => {
    if (onOpenOrUse) {
      onOpenOrUse(item)
      return
    }
    onUse(item)
  }, [item, onOpenOrUse, onUse])

  // Why: sync local assignees on item change / detail resolve, but skip if the user made an optimistic edit so we don't clobber in-flight changes.
  useEffect(() => {
    if (editedAssigneesItemKeyRef.current === assigneesItemKey) {
      return
    }
    setLocalAssignees(assignees)
  }, [assigneesItemKey, assignees])

  const handleStateChange = useCallback(
    (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => {
      runGHEditStateChange({
        newState,
        closeAction,
        localState,
        itemId: item.id,
        itemNumber: item.number,
        itemRepoId: item.repoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        run,
        onStateChange: (state) => {
          if (mountedRef.current) {
            onStateChange(state)
          }
        },
        patchWorkItem,
        patchProjectRowIfNeeded,
        onMutated
      })
    },
    [
      item.id,
      item.number,
      item.repoId,
      localState,
      repoPath,
      sourceContext,
      projectOrigin,
      issueRepo,
      patchWorkItem,
      patchProjectRowIfNeeded,
      run,
      mountedRef,
      onStateChange,
      onMutated
    ]
  )

  const closeAsDuplicate = useCallback(
    (targetIssueNumber: number | string) => {
      closeGHEditAsDuplicate({
        targetIssueNumber,
        itemNumber: item.number,
        setDuplicateError,
        handleStateChange,
        setStatusPopoverOpen,
        setDuplicatePickerOpen
      })
    },
    [handleStateChange, item.number]
  )

  const handleDuplicateSearchSubmit = useCallback(() => {
    const validation = validateTaskPageGitHubDuplicateTarget(duplicateSearch, item.number)
    if (!validation.ok) {
      setDuplicateError(getTaskPageGitHubDuplicateTargetErrorMessage(validation, translate))
      return
    }
    closeAsDuplicate(validation.duplicateOf)
  }, [closeAsDuplicate, duplicateSearch, item.number])

  const handleStatusPopoverOpenChange = useCallback((nextOpen: boolean) => {
    setStatusPopoverOpen(nextOpen)
    if (!nextOpen) {
      setDuplicatePickerOpen(false)
      setDuplicateSearch('')
      setDuplicateError(null)
    }
  }, [])

  const handleLabelToggle = useCallback(
    (label: string) => {
      runGHEditLabelToggle({
        label,
        localLabels,
        itemId: item.id,
        itemNumber: item.number,
        itemRepoId: item.repoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        run,
        onLabelsChange: (labels) => {
          if (mountedRef.current) {
            onLabelsChange(labels)
          }
        },
        patchWorkItem,
        patchProjectRowIfNeeded,
        onMutated
      })
    },
    [
      item.id,
      item.number,
      item.repoId,
      localLabels,
      repoPath,
      sourceContext,
      projectOrigin,
      issueRepo,
      patchWorkItem,
      patchProjectRowIfNeeded,
      run,
      mountedRef,
      onLabelsChange,
      onMutated
    ]
  )

  const handleAssigneeToggle = useCallback(
    (login: string) => {
      runGHEditAssigneeToggle({
        login,
        localAssignees,
        assigneesItemKey,
        editedAssigneesItemKeyRef,
        itemNumber: item.number,
        itemRepoId: item.repoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        run,
        setLocalAssignees,
        patchProjectRowIfNeeded,
        onMutated
      })
    },
    [
      item.number,
      item.repoId,
      assigneesItemKey,
      repoPath,
      sourceContext,
      projectOrigin,
      issueRepo,
      localAssignees,
      patchProjectRowIfNeeded,
      run,
      onMutated
    ]
  )

  if (item.type === 'pr') {
    return null
  }

  const layoutProps = {
    item,
    localState,
    localLabels,
    localAssignees,
    repoLabels,
    repoAssignees,
    repositoryLabelsUrl,
    attachedWorkspaceLabel,
    isStatePending: isPending('state'),
    isAssigneesPending: isPending('assignees'),
    isLabelsPending: isPending('labels'),
    statusPopoverOpen,
    assigneePopoverOpen,
    labelPopoverOpen,
    duplicatePickerOpen,
    duplicateSearch,
    duplicateError,
    duplicatePickerTitle,
    filteredDuplicateCandidates,
    directDuplicateTarget,
    onStatusOpenChange: handleStatusPopoverOpenChange,
    onAssigneeOpenChange: setAssigneePopoverOpen,
    onLabelOpenChange: setLabelPopoverOpen,
    onStateChange: handleStateChange,
    onDuplicateSearchChange: (value: string) => {
      setDuplicateSearch(value)
      setDuplicateError(null)
    },
    onDuplicateSearchSubmit: handleDuplicateSearchSubmit,
    onCloseAsDuplicate: closeAsDuplicate,
    onBackFromDuplicate: () => {
      setDuplicatePickerOpen(false)
      setDuplicateSearch('')
      setDuplicateError(null)
    },
    onOpenDuplicatePicker: () => {
      setDuplicatePickerOpen(true)
      setDuplicateSearch('')
      setDuplicateError(null)
    },
    onAssigneeToggle: handleAssigneeToggle,
    onLabelToggle: handleLabelToggle
  }

  if (layout === 'top-columns') {
    return <GHEditSectionTopColumns {...layoutProps} />
  }

  return (
    <GHEditSectionHorizontal
      {...layoutProps}
      hasAttachedWorkspace={hasAttachedWorkspace}
      onOpenOrUseWorkspace={handleOpenOrUseWorkspace}
      onUse={onUse}
    />
  )
}
