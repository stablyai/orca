// Per-step copy for the agents-orchestration tile in the Explore Orca modal.

export type AgentsStepId = 'statuses' | 'usage' | 'orchestration' | 'notifications'

// Bullets can be either a plain sentence or a {leadIn, body} pair so the UI
// can render the bold "headline" lead-in pattern used on the orchestration
// step ("Create clean lanes for parallel work. Spin up isolated...").
export type AgentsStepBullet =
  | string
  | {
      readonly leadIn: string
      readonly body: string
    }

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
  // Optional prose lead-in rendered above the bullet list. Used on the
  // orchestration step so users read the bullets as the answer to a sentence
  // ("Orca CLI enables agents to: …").
  readonly bulletsLeadIn?: string
  readonly bullets: readonly AgentsStepBullet[]
}

export const AGENTS_STEPS: readonly AgentsStep[] = [
  {
    id: 'statuses',
    name: 'Visibility',
    subtitle: 'Agent Visibility',
    description: 'Track every running agent in each workspace.',
    bullets: [
      'Run several agents in one workspace and see exactly which one needs you.',
      'Realtime status (working, asking for permission, finished) for every running agent.',
      'Works with every major coding agent and CLI we ship support for.'
    ]
  },
  {
    id: 'orchestration',
    name: 'Orchestration',
    subtitle: 'Orchestration',
    description: 'Give agents the power to work together.',
    bulletsLeadIn:
      'With the Orca CLI, agents can spin up focused workspaces, coordinate with each other, and keep complex jobs moving without you managing every handoff.',
    bullets: [
      {
        leadIn: 'Create clean lanes for parallel work.',
        body: 'Agents can open isolated workspaces for each task, keep changes separated, and move multiple efforts forward at once.'
      },
      {
        leadIn: 'Coordinate like an agent team.',
        body: 'Agents can dispatch tasks, share context, ask questions, wait on dependencies, and report results through Orca instead of relying on manual copy-paste.'
      }
    ]
  },
  {
    id: 'notifications',
    name: 'Notifications',
    subtitle: 'Notifications',
    description: 'Orca pings you on the desktop the moment an agent finishes.',
    bullets: [
      'Step away from Orca and come back when an agent needs your attention.',
      'Set a custom notification sound in Settings → Notifications.'
    ]
  },
  {
    id: 'usage',
    name: 'Usage',
    subtitle: 'Usage',
    description:
      'Watch your usage and rate limits across every connected account, so you know when to switch.',
    optional: true,
    bullets: [
      'Live usage and rate-limit resets in the bottom bar, for every account you connect.',
      'Hit your limit? Swap accounts inline without leaving the workspace.'
    ]
  }
] as const

export function getAgentsSteps(): readonly AgentsStep[] {
  return AGENTS_STEPS
}
