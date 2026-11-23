import type { AgentSessionExecutionOptions } from '../protocol/agent-session-execution-options'

/**
 * Cursor's CLI lists one id per effort and fast variant (`grok-4.7-high`). Its ACP session, with
 * the parameterized model picker, takes the base model and those settings as separate options.
 * A variant the session does not list is split against the ids it does list.
 */
export function cursorParameterizedSelection(
  variant: string,
  modelIds: readonly string[]
): Pick<AgentSessionExecutionOptions, 'model' | 'effort' | 'fastMode'> | null {
  if (modelIds.includes(variant)) {
    return null
  }
  const fast = variant.endsWith('-fast')
  const body = fast ? variant.slice(0, -'-fast'.length) : variant
  const base = modelIds
    .filter((id) => body === id || body.startsWith(`${id}-`))
    .sort((left, right) => right.length - left.length)[0]
  if (!base) {
    return null
  }
  let rest = body.slice(base.length).replace(/^-/, '')
  if (rest === 'thinking' || rest.startsWith('thinking-')) {
    rest = rest === 'thinking' ? '' : rest.slice('thinking-'.length)
  }
  return {
    model: base,
    ...(rest ? { effort: rest } : {}),
    fastMode: fast ? 'true' : 'false'
  }
}
