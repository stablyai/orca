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

export function useLinearIssueEditController({
  issue,
  editState,
  onEditStateChange,
  layout = 'chips',
  sourceContext
}: LinearIssueEditSectionProps) {
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false)
  const [estimatePopoverOpen, setEstimatePopoverOpen] = useState(false)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
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

      const prevState = localState
      const stateValue = { name: newState.name, type: newState.type, color: newState.color }

      run('state', {
        mutate: () => linearUpdateIssue(providerSettings, issue.id, { stateId }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ state: stateValue })
          patchLinearIssue(issue.id, { state: stateValue }, { sourceContext })
        },
        onRevert: () => {
          onEditStateChange({ state: prevState })
          patchLinearIssue(issue.id, { state: prevState }, { sourceContext })
        },
        onSuccess: () => {
          useAppStore.getState().invalidateLinearIssueLists({ sourceContext })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      issue.id,
      issue.workspaceId,
      localState,
      providerSettings,
      states.data,
      patchLinearIssue,
      run,
      onEditStateChange,
      sourceContext
    ]
  )

  const handlePriorityChange = useCallback(
    (value: string) => {
      const priority = Number.parseInt(value, 10)
      const prevPriority = localPriority
      run('priority', {
        mutate: () =>
          linearUpdateIssue(providerSettings, issue.id, { priority }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ priority })
          patchLinearIssue(issue.id, { priority }, { sourceContext })
        },
        onRevert: () => {
          onEditStateChange({ priority: prevPriority })
          patchLinearIssue(issue.id, { priority: prevPriority }, { sourceContext })
        },
        onSuccess: () => {
          useAppStore.getState().invalidateLinearIssueLists({ sourceContext })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      issue.id,
      issue.workspaceId,
      localPriority,
      providerSettings,
      patchLinearIssue,
      run,
      onEditStateChange,
      sourceContext
    ]
  )

  const handleEstimateChange = useCallback(
    (estimate: number | null) => {
      const prevEstimate = localEstimate
      run('estimate', {
        mutate: () =>
          linearUpdateIssue(providerSettings, issue.id, { estimate }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ estimate })
          patchLinearIssue(issue.id, { estimate }, { sourceContext })
          setEstimatePopoverOpen(false)
        },
        onRevert: () => {
          onEditStateChange({ estimate: prevEstimate })
          patchLinearIssue(issue.id, { estimate: prevEstimate }, { sourceContext })
        },
        onSuccess: () => {
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      issue.id,
      issue.workspaceId,
      localEstimate,
      providerSettings,
      patchLinearIssue,
      run,
      onEditStateChange,
      sourceContext
    ]
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
      const prevAssignee = localAssignee
      const newAssignee = member
        ? { id: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl }
        : undefined
      run('assignee', {
        mutate: () =>
          linearUpdateIssue(providerSettings, issue.id, { assigneeId }, issue.workspaceId),
        onOptimistic: () => {
          onEditStateChange({ assignee: newAssignee })
          patchLinearIssue(issue.id, { assignee: newAssignee }, { sourceContext })
        },
        onRevert: () => {
          onEditStateChange({ assignee: prevAssignee })
          patchLinearIssue(issue.id, { assignee: prevAssignee }, { sourceContext })
        },
        onSuccess: () => {
          useAppStore.getState().invalidateLinearIssueLists({ sourceContext })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      issue.id,
      issue.workspaceId,
      localAssignee,
      providerSettings,
      members.data,
      patchLinearIssue,
      run,
      onEditStateChange,
      sourceContext
    ]
  )

  const handleLabelToggle = useCallback(
    (labelId: string) => {
      const prevLabelIds = localLabelIds
      const prevLabels = localLabels
      const isRemoving = prevLabelIds.includes(labelId)
      const newLabelIds = isRemoving
        ? prevLabelIds.filter((id) => id !== labelId)
        : [...prevLabelIds, labelId]
      const newLabels = newLabelIds
        .map((id) => labels.data.find((l) => l.id === id)?.name)
        .filter((n): n is string => !!n)

      run('labels', {
        mutate: () =>
          linearUpdateIssue(
            providerSettings,
            issue.id,
            { labelIds: newLabelIds },
            issue.workspaceId
          ),
        onOptimistic: () => {
          onEditStateChange({ labelIds: newLabelIds, labels: newLabels })
          patchLinearIssue(
            issue.id,
            { labelIds: newLabelIds, labels: newLabels },
            { sourceContext }
          )
        },
        onRevert: () => {
          onEditStateChange({ labelIds: prevLabelIds, labels: prevLabels })
          patchLinearIssue(
            issue.id,
            { labelIds: prevLabelIds, labels: prevLabels },
            { sourceContext }
          )
        },
        onSuccess: () => {
          useAppStore.getState().invalidateLinearIssueLists({ sourceContext })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      issue.id,
      issue.workspaceId,
      localLabelIds,
      localLabels,
      providerSettings,
      labels.data,
      patchLinearIssue,
      run,
      onEditStateChange,
      sourceContext
    ]
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
