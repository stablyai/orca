import type { TuiAgent } from './tui-agent'

export const RESUMABLE_TUI_AGENTS = [
  'claude',
  'codebuddy',
  'codex',
  'trae',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'antigravity',
  'opencode',
  'opencode2',
  'pi',
  'mimo-code',
  'droid',
  'grok',
  'devin',
  'omp',
  'prime-agent',
  'copilot',
  'cursor',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro',
  'hermes'
] as const satisfies readonly TuiAgent[]

export type ResumableTuiAgent = (typeof RESUMABLE_TUI_AGENTS)[number]
