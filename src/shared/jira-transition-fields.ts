import type { JiraCreateField, JiraCreateFieldAllowedValue, JiraTransition } from './jira-types'

export type JiraTransitionRequirement =
  | { kind: 'none' }
  | {
      kind: 'form'
      resolution: JiraCreateField | null
      commentRequired: boolean
    }
  | {
      kind: 'unsupported'
      fields: JiraCreateField[]
    }

function isResolutionField(field: JiraCreateField): boolean {
  return field.key === 'resolution' || field.schema?.type === 'resolution'
}

function isCommentField(field: JiraCreateField): boolean {
  return field.key === 'comment' || field.schema?.system === 'comment'
}

export function requiredTransitionFields(transition: JiraTransition): JiraCreateField[] {
  return (transition.fields ?? []).filter((field) => field.required)
}

export function classifyTransitionRequirements(
  transition: JiraTransition
): JiraTransitionRequirement {
  const required = requiredTransitionFields(transition)
  if (required.length === 0) {
    return { kind: 'none' }
  }

  let resolution: JiraCreateField | null = null
  let commentRequired = false
  const unsupported: JiraCreateField[] = []

  for (const field of required) {
    if (isResolutionField(field)) {
      resolution = field
      continue
    }
    if (isCommentField(field)) {
      commentRequired = true
      continue
    }
    unsupported.push(field)
  }

  if (unsupported.length > 0) {
    return { kind: 'unsupported', fields: unsupported }
  }

  return { kind: 'form', resolution, commentRequired }
}

export function transitionAllowedValueLabel(value: JiraCreateFieldAllowedValue): string {
  return value.name ?? value.value ?? value.id ?? 'Option'
}

/** Stable select value / draft key — keep in sync with option `value` and draft seed. */
export function transitionAllowedValueKey(value: JiraCreateFieldAllowedValue): string {
  return value.id ?? value.value ?? value.name ?? ''
}

export function buildResolutionFieldValue(
  field: JiraCreateField,
  selectedId: string
): Record<string, string> | null {
  const trimmed = selectedId.trim()
  if (!trimmed) {
    return null
  }
  const match = field.allowedValues?.find(
    (value) => value.id === trimmed || value.value === trimmed || value.name === trimmed
  )
  if (match?.id) {
    return { id: match.id }
  }
  if (match?.name) {
    return { name: match.name }
  }
  if (match?.value) {
    return { value: match.value }
  }
  return { id: trimmed }
}
