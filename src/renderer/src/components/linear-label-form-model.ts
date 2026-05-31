import type {
  LinearIssueLabel,
  LinearIssueLabelCreateInput,
  LinearIssueLabelUpdateInput,
  LinearTeam,
  LinearWorkspaceSelection
} from '../../../shared/types'

export type LabelFormState = {
  id?: string
  name: string
  color: string
  description: string
  teamId: string
  parentId: string
  isGroup: boolean
}

export type LabelsWorkspaceViewState = 'loading' | 'error' | 'empty' | 'ready'

export function getLinearLabelsWorkspaceViewState({
  loading,
  error,
  labels
}: {
  loading: boolean
  error: string | null
  labels: LinearIssueLabel[]
}): LabelsWorkspaceViewState {
  if (loading && labels.length === 0) {
    return 'loading'
  }
  if (error) {
    return 'error'
  }
  if (labels.length === 0) {
    return 'empty'
  }
  return 'ready'
}

export function reconcileSelectedLinearLabelTeamId(
  selectedTeamId: string,
  teams: LinearTeam[]
): string {
  if (selectedTeamId === 'all') {
    return selectedTeamId
  }
  return teams.some((team) => team.id === selectedTeamId) ? selectedTeamId : 'all'
}

export function emptyLinearLabelForm(teamId = 'workspace'): LabelFormState {
  return {
    name: '',
    color: '#5E6AD2',
    description: '',
    teamId,
    parentId: 'none',
    isGroup: false
  }
}

export function linearLabelFormFromLabel(label: LinearIssueLabel): LabelFormState {
  return {
    id: label.id,
    name: label.name,
    color: label.color || '#5E6AD2',
    description: label.description ?? '',
    teamId: label.teamId ?? 'workspace',
    parentId: label.parentId ?? 'none',
    isGroup: label.isGroup
  }
}

export function compactLinearLabelCreateInput(form: LabelFormState): LinearIssueLabelCreateInput {
  return {
    name: form.name.trim(),
    color: form.color.trim() || undefined,
    description: form.description.trim() || undefined,
    teamId: form.teamId === 'workspace' ? null : form.teamId,
    parentId: form.parentId === 'none' ? null : form.parentId,
    isGroup: form.isGroup
  }
}

export function compactLinearLabelUpdateInput(form: LabelFormState): LinearIssueLabelUpdateInput {
  return {
    name: form.name.trim(),
    color: form.color.trim() || undefined,
    description: form.description.trim() || null,
    parentId: form.parentId === 'none' ? null : form.parentId,
    isGroup: form.isGroup
  }
}

export function selectedWorkspaceCanMutate(
  workspaceId: LinearWorkspaceSelection | null
): workspaceId is string {
  return Boolean(workspaceId && workspaceId !== 'all')
}

export function isLinearLabelRetired(label: LinearIssueLabel): boolean {
  return label.isRetired
}

export function getLinearLabelParentOptions(
  labels: LinearIssueLabel[],
  currentLabelId?: string
): LinearIssueLabel[] {
  return labels.filter(
    (label) => label.isGroup && label.id !== currentLabelId && !isLinearLabelRetired(label)
  )
}
