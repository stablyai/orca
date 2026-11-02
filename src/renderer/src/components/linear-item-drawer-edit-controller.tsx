import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { writeLinearIssue } from '@/lib/linear-issue-write'
import { taskProviderErrorMessage, taskProviderErrorText } from '@/lib/task-provider-error-copy'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import {
  useTeamStates,
  useTeamLabels,
  useTeamMembers,
  useImmediateMutation
} from '@/hooks/useIssueMetadata'
import { linearUpdateIssue } from '@/runtime/runtime-linear-issue-mutations'
import { translate } from '@/i18n/i18n'
import { formatLinearEstimateInput } from '@/components/linear-item-drawer-edit-controls'
import type { LinearIssueEditSectionProps } from '@/components/linear-item-drawer-types'
import { defaultScopeSource } from '@/lib/default-creation-host'

export function useLinearIssueEditController({
  issue,
  editState,
  layout = 'chips',
  sourceContext
}: LinearIssueEditSectionProps) {
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false)
  const [estimatePopoverOpen, setEstimatePopoverOpen] = useState(false)
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? defaultScopeSource(settings)
  const { isPending, run } = useImmediateMutation()

  const {
    state: localState,
    priority: localPriority,
    estimate: localEstimate,
    assignee: localAssignee,
    labelIds: localLabelIds,
    labels: localLabels
  } = editState
  const [estimateInput, setEstimateInput] = useState(() => formatLinearEstimateInput(localEstimate))

  const teamId = issue.team?.id || null
  const states = useTeamStates(teamId, providerSettings, issue.workspaceId)
  const labels = useTeamLabels(teamId, providerSettings, issue.workspaceId)
  const members = useTeamMembers(teamId, providerSettings, issue.workspaceId)

  const handleEstimatePopoverOpenChange = useCallback(
    (open: boolean) => {
      setEstimatePopoverOpen(open)
      if (open) {
        setEstimateInput(formatLinearEstimateInput(localEstimate))
      }
    },
    [localEstimate]
  )

  const handleStateChange = useCallback(
    (stateId: string) => {
      const newState = states.data.find((s) => s.id === stateId)
      if (!newState) {
        return
      }

      const stateValue = { name: newState.name, type: newState.type, color: newState.color }

      const scope = getLinearSourceScope(providerSettings)
      run('state', {
        mutate: () =>
          writeLinearIssue(
            { ...issue, ...editState },
            { state: stateValue },
            providerSettings,
            () => linearUpdateIssue(providerSettings, issue.id, { stateId }, issue.workspaceId)
          ),
        onSuccess: () => {
          useAppStore.getState().invalidateLinearIssueLists({ scope })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        formatError: taskProviderErrorMessage,
        onError: (err) => toast.error(taskProviderErrorText(err))
      })
    },
    [issue, editState, providerSettings, states.data, run]
  )

  const handlePriorityChange = useCallback(
    (value: string) => {
      const priority = Number.parseInt(value, 10)
      const scope = getLinearSourceScope(providerSettings)
      run('priority', {
        mutate: () =>
          writeLinearIssue({ ...issue, ...editState }, { priority }, providerSettings, () =>
            linearUpdateIssue(providerSettings, issue.id, { priority }, issue.workspaceId)
          ),
        onSuccess: () => {
          useAppStore.getState().invalidateLinearIssueLists({ scope })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        formatError: taskProviderErrorMessage,
        onError: (err) => toast.error(taskProviderErrorText(err))
      })
    },
    [issue, editState, providerSettings, run]
  )

  const handleEstimateChange = useCallback(
    (estimate: number | null) => {
      setEstimatePopoverOpen(false)
      run('estimate', {
        mutate: () =>
          writeLinearIssue({ ...issue, ...editState }, { estimate }, providerSettings, () =>
            linearUpdateIssue(providerSettings, issue.id, { estimate }, issue.workspaceId)
          ),
        onSuccess: () => {
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        formatError: taskProviderErrorMessage,
        onError: (err) => toast.error(taskProviderErrorText(err))
      })
    },
    [issue, editState, providerSettings, run]
  )

  const handleEstimateSubmit = useCallback(() => {
    const trimmed = estimateInput.trim()
    if (!trimmed) {
      handleEstimateChange(null)
      return
    }

    const estimate = Number(trimmed)
    if (!Number.isInteger(estimate) || estimate < 0) {
      toast.error(
        translate(
          'auto.components.LinearItemDrawer.0be31fef8e',
          'Estimate must be a non-negative integer'
        )
      )
      return
    }

    handleEstimateChange(estimate)
  }, [estimateInput, handleEstimateChange])

  const handleAssigneeChange = useCallback(
    (memberId: string) => {
      const assigneeId = memberId === '__unassign__' ? null : memberId
      const member = members.data.find((m) => m.id === memberId)
      const newAssignee = member
        ? { id: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl }
        : undefined
      const scope = getLinearSourceScope(providerSettings)
      run('assignee', {
        mutate: () =>
          writeLinearIssue(
            { ...issue, ...editState },
            { assignee: newAssignee },
            providerSettings,
            () => linearUpdateIssue(providerSettings, issue.id, { assigneeId }, issue.workspaceId)
          ),
        onSuccess: () => {
          useAppStore.getState().invalidateLinearIssueLists({ scope })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        formatError: taskProviderErrorMessage,
        onError: (err) => toast.error(taskProviderErrorText(err))
      })
    },
    [issue, editState, providerSettings, members.data, run]
  )

  const handleLabelToggle = useCallback(
    (labelId: string) => {
      const prevLabelIds = localLabelIds
      const isRemoving = prevLabelIds.includes(labelId)
      const newLabelIds = isRemoving
        ? prevLabelIds.filter((id) => id !== labelId)
        : [...prevLabelIds, labelId]
      const newLabels = newLabelIds
        .map((id) => labels.data.find((l) => l.id === id)?.name)
        .filter((n): n is string => !!n)

      const scope = getLinearSourceScope(providerSettings)
      run('labels', {
        mutate: () =>
          writeLinearIssue(
            { ...issue, ...editState },
            { labelIds: newLabelIds, labels: newLabels },
            providerSettings,
            () =>
              linearUpdateIssue(
                providerSettings,
                issue.id,
                { labelIds: newLabelIds },
                issue.workspaceId
              )
          ),
        onSuccess: () => {
          useAppStore.getState().invalidateLinearIssueLists({ scope })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        formatError: taskProviderErrorMessage,
        onError: (err) => toast.error(taskProviderErrorText(err))
      })
    },
    [issue, editState, localLabelIds, providerSettings, labels.data, run]
  )

  const currentStateId = states.data.find(
    (s) => s.name === localState.name && s.type === localState.type
  )?.id
  const statePending = isPending('state')
  const priorityPending = isPending('priority')
  const estimatePending = isPending('estimate')
  const assigneePending = isPending('assignee')
  const labelsPending = isPending('labels')
  const labelSummary =
    localLabels.length === 0
      ? '+ Label'
      : localLabels.length === 1
        ? localLabels[0]
        : `${localLabels[0]} +${localLabels.length - 1}`

  const checkIcon = (
    <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  return {
    layout,
    labelPopoverOpen,
    setLabelPopoverOpen,
    estimatePopoverOpen,
    localState,
    localPriority,
    localEstimate,
    localAssignee,
    localLabelIds,
    localLabels,
    estimateInput,
    setEstimateInput,
    states,
    labels,
    members,
    handleEstimatePopoverOpenChange,
    handleStateChange,
    handlePriorityChange,
    handleEstimateChange,
    handleEstimateSubmit,
    handleAssigneeChange,
    handleLabelToggle,
    currentStateId,
    statePending,
    priorityPending,
    estimatePending,
    assigneePending,
    labelsPending,
    labelSummary,
    checkIcon
  }
}

export type LinearIssueEditController = ReturnType<typeof useLinearIssueEditController>
