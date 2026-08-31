import type { AgentHookSource } from '../agent-hook-relay'

// ─── URL routing ────────────────────────────────────────────────────

export const HOOK_SOURCE_BY_PATHNAME: Readonly<Record<string, AgentHookSource>> = Object.freeze({
  '/hook/claude': 'claude',
  '/hook/codex': 'codex',
  '/hook/gemini': 'gemini',
  '/hook/antigravity': 'antigravity',
  '/hook/amp': 'amp',
  '/hook/opencode': 'opencode',
  '/hook/mimo-code': 'mimo-code',
  '/hook/cursor': 'cursor',
  '/hook/pi': 'pi',
  '/hook/omp': 'omp',
  '/hook/prime-agent': 'prime-agent',
  '/hook/droid': 'droid',
  '/hook/command-code': 'command-code',
  '/hook/grok': 'grok',
  '/hook/copilot': 'copilot',
  '/hook/hermes': 'hermes',
  '/hook/devin': 'devin',
  '/hook/kimi': 'kimi'
})

export function resolveHookSource(pathname: string): AgentHookSource | null {
  return HOOK_SOURCE_BY_PATHNAME[pathname] ?? null
}
