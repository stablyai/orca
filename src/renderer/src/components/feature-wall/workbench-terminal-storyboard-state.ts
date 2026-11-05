export type WorkbenchAnimationPhase =
  | { kind: 'idle' }
  | { kind: 'hover' }
  | { kind: 'right-click' }
  | { kind: 'menu-open' }
  | { kind: 'menu-active' }
  | { kind: 'menu-click' }
  | { kind: 'split-empty' }
  | { kind: 'split-active' }

export type WorkbenchTerminalLine =
  | { kind: 'submitted-command'; text: string }
  | { kind: 'session-started' }
  | { kind: 'submitted-prompt'; text: string }
  | { kind: 'thinking' }
  | { kind: 'agent-action'; action: string; target: string; working?: boolean }
  | { kind: 'response-skeleton'; widthPct: number; withGlyph: boolean }

export type WorkbenchCursorTarget = { kind: 'hidden' } | { kind: 'pane' } | { kind: 'split-row' }

export type WorkbenchAnimatedVisualVariant = 'tour' | 'two-agents-checklist'

export const WORKBENCH_RUN_QUEUE: readonly { name: string; desc: string }[] = [
  { name: 'dashboard.spec.ts', desc: '› renders metrics' },
  { name: 'profile.spec.ts', desc: '› updates avatar' },
  { name: 'invoices.spec.ts', desc: '› exports CSV' },
  { name: 'settings.spec.ts', desc: '› toggles dark mode' }
]

export const WORKBENCH_RUN_TICK_MS = 2400
export const WORKBENCH_CLAUDE_COMMAND = 'claude'
export const WORKBENCH_REVIEW_PROMPT = 'review src/auth for missing error handling'
export const WORKBENCH_CODEX_COMMAND = 'codex'
export const WORKBENCH_CODEX_PROMPT = 'fix failing checkout test'
export const WORKBENCH_RESPONSE_WIDTHS = [72, 88, 64, 78] as const

export function getTwoAgentsReducedMotionLines(): readonly WorkbenchTerminalLine[] {
  return [
    { kind: 'submitted-command', text: WORKBENCH_CODEX_COMMAND },
    { kind: 'session-started' },
    { kind: 'submitted-prompt', text: WORKBENCH_CODEX_PROMPT },
    { kind: 'agent-action', action: 'Read', target: 'checkout.test.ts' },
    { kind: 'agent-action', action: 'Grep', target: 'timeout checkout' },
    { kind: 'agent-action', action: 'Edit', target: 'src/checkout.ts', working: true }
  ]
}
