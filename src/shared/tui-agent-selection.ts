import type { TuiAgent } from './types'

// Keep this order in sync with the desktop agent catalog. It defines the
// automatic fallback priority when the user has not chosen a default agent.
export const TUI_AGENT_AUTO_PICK_ORDER = [
  'claude',
  'codex',
  'grok',
  'copilot',
  'opencode',
  'pi',
  'omp',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'autohand',
  'cline',
  'codebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'openclaw'
] as const satisfies readonly TuiAgent[]

export function pickTuiAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detected: Iterable<TuiAgent>
): TuiAgent | null {
  if (preferred === 'blank') {
    return null
  }
  const detectedSet = detected instanceof Set ? detected : new Set(detected)
  if (preferred && detectedSet.has(preferred)) {
    return preferred
  }
  for (const agent of TUI_AGENT_AUTO_PICK_ORDER) {
    if (detectedSet.has(agent)) {
      return agent
    }
  }
  return null
}
