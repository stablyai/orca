export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6
export type StepId = 'agent' | 'theme' | 'notifications' | 'agentSetup' | 'integrations' | 'repo'

export const STEPS: readonly {
  id: StepId
  stepNumber: StepNumber
  valueKind: 'agent' | 'theme' | 'notifications' | 'agent_setup' | 'integrations' | 'repo'
}[] = [
  { id: 'agent', stepNumber: 1, valueKind: 'agent' },
  { id: 'theme', stepNumber: 2, valueKind: 'theme' },
  { id: 'notifications', stepNumber: 3, valueKind: 'notifications' },
  { id: 'agentSetup', stepNumber: 4, valueKind: 'agent_setup' },
  { id: 'integrations', stepNumber: 5, valueKind: 'integrations' },
  { id: 'repo', stepNumber: 6, valueKind: 'repo' }
]
