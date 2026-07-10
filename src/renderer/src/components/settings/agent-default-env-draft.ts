import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

// Why: environment overrides are pasteable settings text; reject huge drafts before tokenizing.
export const AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES = 8 * 1024

export type AgentDefaultEnvDraftParseResult = {
  env: Record<string, string>
  tooLarge: boolean
}

export function stringifyAgentDefaultEnvDraft(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ')
}

export function parseAgentDefaultEnvDraft(value: string): AgentDefaultEnvDraftParseResult {
  if (isClipboardTextByteLengthOverLimit(value, AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES)) {
    return { env: {}, tooLarge: true }
  }

  const env: Record<string, string> = {}
  for (const pair of getAgentDefaultEnvDraftPairs(value)) {
    const separatorIndex = pair.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    const name = pair.slice(0, separatorIndex).trim()
    if (!name) {
      continue
    }
    env[name] = pair.slice(separatorIndex + 1)
  }
  return { env, tooLarge: false }
}

function getAgentDefaultEnvDraftPairs(value: string): string[] {
  const pairs: string[] = []
  let tokenStart = -1

  for (let index = 0; index <= value.length; index += 1) {
    const isEnd = index === value.length
    if (!isEnd && !isAgentDefaultEnvDraftWhitespace(value.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index
      }
      continue
    }
    if (tokenStart !== -1) {
      pairs.push(value.slice(tokenStart, index))
      tokenStart = -1
    }
  }

  return pairs
}

function isAgentDefaultEnvDraftWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}
