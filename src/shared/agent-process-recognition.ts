import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { AgentType } from './agent-status-types'
import type { TuiAgent } from './types'
import { filterHeadlessOneShotAgentCommand } from './agent-headless-command'
import { getFirstCommandToken } from './command-token-scanner'
import { getCodexStartupRetryInnerCommand } from './codex-startup-retry'
import {
  findInterpreterEntrypointToken,
  isPythonProcessName,
  tokenizeCommandLine
} from './agent-command-line-entrypoint'

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

const FOREGROUND_AGENT_WRAPPER_PROCESS_NAMES = new Set(['node', 'python', 'python3'])
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
  const moduleFlagIndex = tokens.findIndex((token) => token === '-m')
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
function recognizePlainAgentCommandLine(commandLine: string): RecognizedAgentProcess | null {
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

export function recognizeAgentProcessFromCommandLine(
  commandLine: string | null | undefined
): RecognizedAgentProcess | null {
  if (!commandLine) {
    return null
  }
  // Why: Orca's Codex startup retry wrapper runs Codex from a shell function,
  // but startup routing still needs the proven underlying agent identity.
  const retryInnerCommand = getCodexStartupRetryInnerCommand(commandLine)
  if (retryInnerCommand) {
    const innerRecognition = recognizePlainAgentCommandLine(retryInnerCommand)
    return innerRecognition?.agent === 'codex' ? innerRecognition : null
  }
  return recognizePlainAgentCommandLine(commandLine)
}
export function isAgentForegroundWrapperProcess(processName: string | null | undefined): boolean {
  const normalized = normalizeProcessName(processName)
  return FOREGROUND_AGENT_WRAPPER_PROCESS_NAMES.has(normalized) || isPythonProcessName(normalized)
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
