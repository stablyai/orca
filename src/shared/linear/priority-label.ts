export const LINEAR_PRIORITY_LABELS = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low'
} as const

export type LinearPriorityLabel =
  (typeof LINEAR_PRIORITY_LABELS)[keyof typeof LINEAR_PRIORITY_LABELS]

export function linearPriorityLabel(priority: number | null | undefined): LinearPriorityLabel {
  if (priority === 1 || priority === 2 || priority === 3 || priority === 4) {
    return LINEAR_PRIORITY_LABELS[priority]
  }
  return LINEAR_PRIORITY_LABELS[0]
}
