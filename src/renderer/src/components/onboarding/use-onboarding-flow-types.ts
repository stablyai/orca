export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7
export type StepId =
  | 'agent'
  | 'theme'
  | 'notifications'
  | 'agentSetup'
  | 'integrations'
  | 'tour'
  | 'repo'

export const STEPS: readonly {
  id: StepId
  stepNumber: StepNumber
  valueKind: 'agent' | 'theme' | 'notifications' | 'agent_setup' | 'integrations' | 'tour' | 'repo'
}[] = [
  { id: 'agent', stepNumber: 1, valueKind: 'agent' },
  { id: 'theme', stepNumber: 2, valueKind: 'theme' },
  { id: 'notifications', stepNumber: 3, valueKind: 'notifications' },
  { id: 'agentSetup', stepNumber: 4, valueKind: 'agent_setup' },
  { id: 'integrations', stepNumber: 5, valueKind: 'integrations' },
  { id: 'tour', stepNumber: 6, valueKind: 'tour' },
  { id: 'repo', stepNumber: 7, valueKind: 'repo' }
]
