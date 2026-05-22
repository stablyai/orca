// Per-step copy for the workbench tile in the Explore Orca modal. Mirrors
// agents-orchestration-steps.ts so the rail / body code can render both the
// same way.

export type WorkbenchStepId = 'terminal' | 'editor' | 'browser'

export type WorkbenchStepBullet =
  | string
  | {
      readonly leadIn: string
      readonly body: string
    }

export type WorkbenchStep = {
  readonly id: WorkbenchStepId
  // Short label rendered in the rail.
  readonly name: string
  // Subtitle shown directly under the modal's main title.
  readonly subtitle: string
  // One-sentence summary rendered under the subtitle.
  readonly description: string
  // Optional prose paragraph rendered above the bullets — used when a step
  // needs a longer secondary framing line before the bulleted list.
  readonly bulletsLeadIn?: string
  readonly bullets: readonly WorkbenchStepBullet[]
}

export const WORKBENCH_STEPS: readonly WorkbenchStep[] = [
  {
    id: 'terminal',
    name: 'Terminal',
    subtitle: 'Terminal',
    description:
      'A fast configurable terminal — tabs, splits, and your own profile in every workspace.',
    bullets: [
      {
        leadIn: 'Splits, by keystroke or right-click.',
        body: '⌘D splits right, ⌘⇧D splits down — keep one workspace, run several things at once.'
      },
      {
        leadIn: 'Configurable.',
        body: 'Bring your own profile — fonts, theme, shell — same setup in every workspace.'
      }
    ]
  },
  {
    id: 'editor',
    name: 'Editor',
    subtitle: 'Editor',
    description:
      'A rich-text markdown editor for project notes — slash commands, inline blocks, autosave.',
    bullets: [
      {
        leadIn: 'Notion-style markdown.',
        body: 'Write project notes in a real document surface — headings, lists, quotes, code blocks all render as you type.'
      }
    ]
  },
  {
    id: 'browser',
    name: 'Browser',
    subtitle: 'Browser',
    description:
      'Run your app inside Orca, inspect the UI with Design Mode, and let agents navigate, click, and verify what they’re building.',
    bullets: [
      {
        leadIn: 'Browse where the work happens.',
        body: 'Run your dev server, sign in, and click through the product without leaving your terminal, editor, or agents.'
      },
      {
        leadIn: 'Inspect UI with Design Mode.',
        body: 'Click any element to see its tag, classes, and selector, then hand that exact context to your agent.'
      },
      {
        leadIn: 'Let agents drive the browser.',
        body: 'With the Orca CLI skill, enable your agents to navigate, click, inspect, and gather UI evidence for you.'
      },
      {
        leadIn: 'Zero setup.',
        body: 'Pull cookies from your existing browser so you’re signed in from the first open.'
      }
    ]
  }
] as const

export function getWorkbenchSteps(): readonly WorkbenchStep[] {
  return WORKBENCH_STEPS
}
