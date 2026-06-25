export type StepNumber = 1 | 2 | 3 | 4 | 5
export type StepId = 'agent' | 'theme' | 'integrations' | 'windows_terminal' | 'notifications'

export const STEPS: readonly {
  id: StepId
  stepNumber: StepNumber
  valueKind: 'agent' | 'theme' | 'integrations' | 'windows_terminal' | 'notifications'
}[] = [
  { id: 'agent', stepNumber: 1, valueKind: 'agent' },
  { id: 'theme', stepNumber: 2, valueKind: 'theme' },
  { id: 'integrations', stepNumber: 3, valueKind: 'integrations' },
  { id: 'windows_terminal', stepNumber: 4, valueKind: 'windows_terminal' },
  { id: 'notifications', stepNumber: 5, valueKind: 'notifications' }
]
