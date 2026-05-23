export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6
export type StepId = 'agent' | 'theme' | 'notifications' | 'integrations' | 'tour' | 'repo'

export const STEPS: readonly {
  id: StepId
  stepNumber: StepNumber
  valueKind: 'agent' | 'theme' | 'notifications' | 'integrations' | 'tour' | 'repo'
}[] = [
  { id: 'agent', stepNumber: 1, valueKind: 'agent' },
  { id: 'theme', stepNumber: 2, valueKind: 'theme' },
  { id: 'notifications', stepNumber: 3, valueKind: 'notifications' },
  { id: 'integrations', stepNumber: 4, valueKind: 'integrations' },
  { id: 'tour', stepNumber: 5, valueKind: 'tour' },
  { id: 'repo', stepNumber: 6, valueKind: 'repo' }
]
