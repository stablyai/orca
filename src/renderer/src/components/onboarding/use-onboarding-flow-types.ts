export type StepNumber = 1 | 2 | 3 | 4 | 5
export type StepId =
  | 'agent_surface'
  | 'agent'
  | 'theme'
  | 'integrations'
  | 'windows_terminal'
  | 'notifications'

export type AgentSurface = 'chat' | 'terminal'

// Why: the Chat/Terminal page shares step 1 with the agent page so persisted progress and step telemetry keep their numbering.
export const STEPS: readonly {
  id: StepId
  stepNumber: StepNumber
  valueKind: 'agent' | 'theme' | 'integrations' | 'windows_terminal' | 'notifications'
}[] = [
  { id: 'agent_surface', stepNumber: 1, valueKind: 'agent' },
  { id: 'agent', stepNumber: 1, valueKind: 'agent' },
  { id: 'theme', stepNumber: 2, valueKind: 'theme' },
  { id: 'integrations', stepNumber: 3, valueKind: 'integrations' },
  { id: 'windows_terminal', stepNumber: 4, valueKind: 'windows_terminal' },
  { id: 'notifications', stepNumber: 5, valueKind: 'notifications' }
]

/** Resume at the first page past the last completed step number; finished flows reopen on the last page. */
export function stepIndexAfterCompletedStep(lastCompletedStep: number): number {
  const index = STEPS.findIndex((step) => step.stepNumber > lastCompletedStep)
  return index === -1 ? STEPS.length - 1 : index
}
