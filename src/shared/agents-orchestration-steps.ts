// Per-step copy for the agents-orchestration tile in the Explore Orca modal.

export type AgentsStepId = 'statuses' | 'usage' | 'orchestration'

export type AgentsStep = {
  readonly id: AgentsStepId
  // Short label rendered in the bottom stepper.
  readonly name: string
  // Subtitle shown directly under the modal's main title — "you are looking
  // at this slice of the workflow".
  readonly subtitle: string
  // One-sentence summary rendered under the subtitle.
  readonly description: string
  // Whether the step is optional — surfaced as an "Optional" pill next to the
  // subtitle so users know they can skip the related setup.
  readonly optional?: boolean
}

export const AGENTS_STEPS: readonly AgentsStep[] = [
  {
    id: 'statuses',
    name: 'Visibility',
    subtitle: 'Agent Visibility',
    description: 'Know which agents are working, waiting, live, or blocked.'
  },
  {
    id: 'orchestration',
    name: 'Orchestration',
    subtitle: 'Orchestration',
    description: 'Enable agents to manage and coordinate Orca workspaces to execute larger tasks.'
  },
  {
    id: 'usage',
    name: 'Usage',
    subtitle: 'Usage',
    description:
      'Watch your usage and rate limits across every connected account, so you know when to switch.',
    optional: true
  }
] as const

export function getAgentsSteps(): readonly AgentsStep[] {
  return AGENTS_STEPS
}
