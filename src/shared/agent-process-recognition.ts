import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { AgentType } from './agent-status-types'
import type { TuiAgent } from './types'
import { filterHeadlessOneShotAgentCommand } from './agent-headless-command'
import { getFirstCommandToken } from './command-token-scanner'

export type RecognizedAgentProcess = { agent: TuiAgent; processName: string }

const PROCESS_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i
const INTERPRETER_SCRIPT_EXTENSION_RE = /\.(?:js|mjs|cjs)$/i
const PYTHON_SCRIPT_EXTENSION_RE = /\.(?:py|pyw)$/i

function normalizeProcessName(
  processName: string | null | undefined,
  options: { stripInterpreterScriptExtension?: boolean } = {}
): string {
  if (!processName) {
    return ''
  }
  const unquoted = processName.trim().replace(/^["']|["']$/g, '')
  const basename = unquoted.split(/[\\/]/).pop() ?? unquoted
  const withoutProcessExtension = basename.toLowerCase().replace(PROCESS_EXTENSION_RE, '')
  if (options.stripInterpreterScriptExtension === true) {
    return withoutProcessExtension.replace(INTERPRETER_SCRIPT_EXTENSION_RE, '')
  }
  return withoutProcessExtension
}

const STATIC_INTERPRETER_PROCESS_NAMES = new Set([
  'node',
  'python',
  'python3',
  'bash',
  'zsh',
  'sh',
  'fish',
  'pwsh',
  'powershell'
])

const FOREGROUND_AGENT_WRAPPER_PROCESS_NAMES = new Set(['node', 'python', 'python3'])
const PYTHON_PROCESS_RE = /^python(?:\d+(?:\.\d+)*)?$/
const INTERPRETER_OPTIONS_WITH_VALUE = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader'
])
const INTERPRETER_OPTIONS_WITH_INLINE_SOURCE = new Set(['-e', '--eval', '-p', '--print', '--check'])
const NODE_PACKAGE_SCRIPT_ENTRYPOINTS: Record<string, readonly string[]> = {
  codex: ['node_modules/@openai/codex/'],
  gemini: ['node_modules/@google/gemini-cli/']
}
const PYTHON_SCRIPT_ENTRYPOINT_DIRECTORIES = ['/bin/', '/scripts/', '/site-packages/']

const PROCESS_TO_AGENT = new Map<string, TuiAgent>()
const AGENT_TYPE_IDS = new Set<TuiAgent>()

for (const [agent, config] of Object.entries(TUI_AGENT_CONFIG) as [
  TuiAgent,
  (typeof TUI_AGENT_CONFIG)[TuiAgent]
][]) {
  AGENT_TYPE_IDS.add(agent)
  for (const candidate of [
    config.expectedProcess,
    ...getTuiAgentDetectCommands(config),
    getFirstCommandToken(config.launchCmd)
  ]) {
    const normalized = normalizeProcessName(candidate)
    if (normalized) {
      // Why: claude-agent-teams is an Orca wrapper whose child process is the
      // real `claude` binary. Do not let wrapper configs overwrite canonical
      // CLI ownership for the same foreground process name.
      if (!PROCESS_TO_AGENT.has(normalized)) {
        PROCESS_TO_AGENT.set(normalized, agent)
      }
    }
  }
}

function agentForNormalizedProcess(normalized: string): TuiAgent | undefined {
  const exact = PROCESS_TO_AGENT.get(normalized)
  if (exact) {
    return exact
  }
  // Why: node-pty can report Codex's packaged platform binary
  // (for example codex-aarch64-ap) instead of the launch command.
  if (normalized.startsWith('codex-')) {
    return PROCESS_TO_AGENT.get('codex')
  }
  if (normalized.startsWith('grok-')) {
    return PROCESS_TO_AGENT.get('grok')
  }
  return undefined
}

function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      const next = commandLine[index + 1]
      if (next && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
        escaped = true
        continue
      }
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char
      continue
    }
    if (quote === char) {
      quote = null
      continue
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

function tokenLooksExecutable(token: string, index: number, firstNormalized: string): boolean {
  if (index === 0) {
    return true
  }
  if (!isInterpreterProcessName(firstNormalized)) {
    return false
  }
  // Why: only inspect interpreter script paths. Prompt text can mention other
  // agents ("compare opencode vs orca"), and treating every argv token as an
  // executable would reintroduce the substring-style false identity class that
  // foreground-process detection is meant to avoid.
  return token.includes('/') || token.includes('\\') || PROCESS_EXTENSION_RE.test(token)
}

function isInterpreterProcessName(normalized: string): boolean {
  return STATIC_INTERPRETER_PROCESS_NAMES.has(normalized) || PYTHON_PROCESS_RE.test(normalized)
}

function isPythonProcessName(normalized: string): boolean {
  return PYTHON_PROCESS_RE.test(normalized)
}

function optionName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

function findInterpreterEntrypointToken(tokens: string[], firstNormalized: string): string | null {
  if (!isInterpreterProcessName(firstNormalized)) {
    return null
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      continue
    }
    if (isPythonProcessName(firstNormalized) && token === '-m') {
      return tokens[index + 1] ?? null
    }
    if (token.startsWith('-')) {
      const name = optionName(token)
      if (INTERPRETER_OPTIONS_WITH_INLINE_SOURCE.has(name)) {
        return null
      }
      if (INTERPRETER_OPTIONS_WITH_VALUE.has(name) && name === token) {
        index += 1
      }
      continue
    }
    if (tokenLooksExecutable(token, index, firstNormalized)) {
      return token
    }
  }
  return null
}

function comparablePath(token: string): string {
  return token
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

function recognizeNodeScriptEntrypoint(token: string): RecognizedAgentProcess | null {
  const normalized = normalizeProcessName(token, { stripInterpreterScriptExtension: true })
  const markers = NODE_PACKAGE_SCRIPT_ENTRYPOINTS[normalized]
  if (!markers) {
    return null
  }
  const path = comparablePath(token)
  if (!markers.some((marker) => path.includes(marker))) {
    return null
  }
  const agent = agentForNormalizedProcess(normalized)
  if (!agent) {
    return null
  }
  return { agent, processName: normalized }
}

function recognizePythonModule(
  moduleName: string | null | undefined
): RecognizedAgentProcess | null {
  if (!moduleName || moduleName.startsWith('-')) {
    return null
  }
  const normalized = moduleName.split('.', 1)[0]?.toLowerCase() ?? ''
  const agent = agentForNormalizedProcess(normalized)
  if (!agent) {
    return null
  }
  return { agent, processName: normalized }
}

function recognizePythonScriptEntrypoint(token: string): RecognizedAgentProcess | null {
  const path = comparablePath(token)
  if (!PYTHON_SCRIPT_EXTENSION_RE.test(path)) {
    return null
  }
  if (!PYTHON_SCRIPT_ENTRYPOINT_DIRECTORIES.some((marker) => path.includes(marker))) {
    return null
  }
  const basename = path.split('/').pop() ?? ''
  const normalized = basename.replace(PYTHON_SCRIPT_EXTENSION_RE, '')
  const agent = agentForNormalizedProcess(normalized)
  if (!agent) {
    return null
  }
  return { agent, processName: normalized }
}

function recognizePythonEntrypoint(
  tokens: string[],
  entrypoint: string
): RecognizedAgentProcess | null {
  const moduleFlagIndex = tokens.indexOf('-m')
  if (moduleFlagIndex > 0) {
    return recognizePythonModule(tokens[moduleFlagIndex + 1])
  }
  return recognizeAgentProcess(entrypoint) ?? recognizePythonScriptEntrypoint(entrypoint)
}

export function isExpectedAgentProcess(
  processName: string | null | undefined,
  expectedProcess: string
): boolean {
  const normalizedProcess = normalizeProcessName(processName)
  const normalizedExpected = normalizeProcessName(expectedProcess)
  if (!normalizedProcess || !normalizedExpected) {
    return false
  }
  return (
    normalizedProcess === normalizedExpected ||
    normalizedProcess.startsWith(`${normalizedExpected}.`)
  )
}

export function recognizeAgentProcess(
  processName: string | null | undefined
): RecognizedAgentProcess | null {
  const normalized = normalizeProcessName(processName)
  const agent = agentForNormalizedProcess(normalized)
  if (!agent) {
    return null
  }
  return { agent, processName: normalized }
}
export function recognizeAgentProcessFromCommandLine(
  commandLine: string | null | undefined
): RecognizedAgentProcess | null {
  if (!commandLine) {
    return null
  }
  const tokens = tokenizeCommandLine(commandLine)
  const firstNormalized = normalizeProcessName(tokens[0])
  const directRecognition = filterHeadlessOneShotAgentCommand(
    recognizeAgentProcess(tokens[0]),
    tokens
  )
  if (directRecognition) {
    return directRecognition
  }
  const entrypoint = findInterpreterEntrypointToken(tokens, firstNormalized)
  if (!entrypoint) {
    return null
  }
  const entrypointRecognition = isPythonProcessName(firstNormalized)
    ? recognizePythonEntrypoint(tokens, entrypoint)
    : (recognizeAgentProcess(entrypoint) ?? recognizeNodeScriptEntrypoint(entrypoint))
  return filterHeadlessOneShotAgentCommand(entrypointRecognition, tokens)
}
export function isAgentForegroundWrapperProcess(processName: string | null | undefined): boolean {
  const normalized = normalizeProcessName(processName)
  return (
    FOREGROUND_AGENT_WRAPPER_PROCESS_NAMES.has(normalized) || PYTHON_PROCESS_RE.test(normalized)
  )
}

export function isRecognizedAgentType(agentType: AgentType | null | undefined): boolean {
  if (typeof agentType !== 'string') {
    return false
  }
  return (
    AGENT_TYPE_IDS.has(agentType as TuiAgent) ||
    agentForNormalizedProcess(normalizeProcessName(agentType)) !== undefined
  )
}
