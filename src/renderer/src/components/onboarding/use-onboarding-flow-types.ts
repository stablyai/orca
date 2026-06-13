export type StepNumber = 1 | 2 | 3 | 4
export type StepId = 'agent' | 'theme' | 'integrations' | 'notifications'

export const STEPS: readonly {
  id: StepId
  stepNumber: StepNumber
  valueKind: 'agent' | 'theme' | 'integrations' | 'notifications'
}[] = [
  { id: 'agent', stepNumber: 1, valueKind: 'agent' },
  { id: 'theme', stepNumber: 2, valueKind: 'theme' },
  { id: 'integrations', stepNumber: 3, valueKind: 'integrations' },
  { id: 'notifications', stepNumber: 4, valueKind: 'notifications' }
]
