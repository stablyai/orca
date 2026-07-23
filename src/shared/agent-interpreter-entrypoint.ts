import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './types'

type InterpreterScriptDefinition = {
  agent: TuiAgent
  pathMarkers: readonly string[]
}

const INTERPRETER_SCRIPT_ENTRYPOINTS: Record<string, InterpreterScriptDefinition> = {
  codex: { agent: 'codex', pathMarkers: ['node_modules/@openai/codex/'] },
  gemini: { agent: 'gemini', pathMarkers: ['node_modules/@google/gemini-cli/'] },
  'adal-cli': {
    agent: 'adal',
    // Why: AdaL's supported installers exec a bundled Bun script; qualify its generic filename to avoid classifying unrelated scripts.
    pathMarkers: [
      '/.adal/versions/',
      'node_modules/@sylphai/adal-cli/',
      'node_modules/@sylphai/adal-cli-'
    ]
  }
}

function normalizeScriptName(token: string): string {
  const path = token
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
  return (path.split('/').pop() ?? path).toLowerCase().replace(/\.(?:js|mjs|cjs)$/i, '')
}

function normalizeScriptPath(token: string): string {
  return token
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

export function recognizeAgentInterpreterEntrypoint(
  token: string
): { agent: TuiAgent; processName: string } | null {
  const definition = INTERPRETER_SCRIPT_ENTRYPOINTS[normalizeScriptName(token)]
  if (!definition) {
    return null
  }
  const path = normalizeScriptPath(token)
  if (!definition.pathMarkers.some((marker) => path.includes(marker))) {
    return null
  }
  return {
    agent: definition.agent,
    processName: TUI_AGENT_CONFIG[definition.agent].expectedProcess
  }
}
