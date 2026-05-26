// Per-step copy for the workbench tile in the Explore Orca modal. Mirrors
// agents-orchestration-steps.ts so the rail / body code can render both the
// same way.

export type WorkbenchStepId = 'terminal' | 'editor' | 'browser'

export type WorkbenchStep = {
  readonly id: WorkbenchStepId
  // Short label rendered in the rail.
  readonly name: string
  // Subtitle shown directly under the modal's main title.
  readonly subtitle: string
  // One-sentence summary rendered under the subtitle.
  readonly description: string
}

export const WORKBENCH_STEPS: readonly WorkbenchStep[] = [
  {
    id: 'terminal',
    name: 'Terminal',
    subtitle: 'Terminal',
    description: 'Keep your agents, tests, and dev logs visible at once.'
  },
  {
    id: 'editor',
    name: 'Editor',
    subtitle: 'Editor',
    description: 'Use our Notion-style markdown editor to write notes without leaving Orca.'
  },
  {
    id: 'browser',
    name: 'Browser',
    subtitle: 'Browser',
    description:
      "Run your app in Orca's browser, send selected UI elements to agents, and let your agents interact with your webpage."
  }
] as const

export function getWorkbenchSteps(): readonly WorkbenchStep[] {
  return WORKBENCH_STEPS
}
