import { getTuiAgentDetectCommands, isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { EXACT_NODE_ENTRYPOINT_IDENTITIES } from './agent-node-entrypoint-identities'
import { NODE_PACKAGE_SCRIPT_ENTRYPOINTS } from './agent-node-package-entrypoints'
import type { AgentType } from './agent-status-types'
import type { TerminalAgent } from './terminal-agent'
import { filterHeadlessOneShotAgentCommand } from './agent-headless-command'
import { getFirstCommandToken } from './command-token-scanner'
import {
  comparablePath,
  findInterpreterEntrypointToken,
  PYTHON_PROCESS_RE,
  tokenizeCommandLine
} from './agent-command-line-entrypoint'
import { isFreshOmpLaunchCommand } from './omp-fresh-launch'

export type RecognizedAgentProcess = { agent: TerminalAgent; processName: string }

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
const PYTHON_SCRIPT_ENTRYPOINT_DIRECTORIES = ['/bin/', '/scripts/', '/site-packages/']

const PROCESS_TO_AGENT = new Map<string, TerminalAgent>([
  ['dsb', 'dsb'],
  ['deepseek-build', 'dsb'],
  ['deepseek-build-agent', 'dsb']
])
const AGENT_TYPE_IDS = new Set<string>(['dsb'])

for (const [agent, config] of Object.entries(TUI_AGENT_CONFIG)) {
  if (!isTuiAgent(agent)) {
    continue
  }
  AGENT_TYPE_IDS.add(agent)
  for (const candidate of [
    config.expectedProcess,
    ...getTuiAgentDetectCommands(config),
    getFirstCommandToken(config.launchCmd)
  ]) {
    const normalized = normalizeProcessName(candidate)
    if (normalized) {
      // claude-agent-teams wraps real claude; wrapper config must not overwrite its canonical foreground ownership.
      if (!PROCESS_TO_AGENT.has(normalized)) {
        PROCESS_TO_AGENT.set(normalized, agent)
      }
    }
  }
}

function agentForNormalizedProcess(normalized: string): TerminalAgent | undefined {
  const exact = PROCESS_TO_AGENT.get(normalized)
  if (exact) {
    return exact
  }
  // node-pty may report Codex's packaged platform binary rather than its launch command.
  if (normalized.startsWith('codex-')) {
    return PROCESS_TO_AGENT.get('codex')
  }
  // Qoder's launcher resolves to a versioned native binary.
  if (/^(?:qoderclicn|qodercn)-\d/.test(normalized)) {
    return PROCESS_TO_AGENT.get('qoderclicn')
  }
  if (/^qodercli-\d/.test(normalized)) {
    return PROCESS_TO_AGENT.get('qodercli')
  }
  if (normalized.startsWith('grok-')) {
    return PROCESS_TO_AGENT.get('grok')
  }
  // Muse execs a versioned muse-bin binary; this prefix also covers truncated comm without matching unrelated muse-* tools.
  if (normalized.startsWith('muse-bin-')) {
    return PROCESS_TO_AGENT.get('muse')
  }
  return undefined
}

function recognizedAgentForProcess(normalized: string): RecognizedAgentProcess | null {
  const agent = agentForNormalizedProcess(normalized)
  return agent ? { agent, processName: normalized } : null
}

function recognizeNodeScriptEntrypoint(token: string): RecognizedAgentProcess | null {
  const path = comparablePath(token)
  for (const identity of EXACT_NODE_ENTRYPOINT_IDENTITIES) {
    if (identity.pattern.test(path)) {
      return { agent: identity.agent, processName: identity.processName }
    }
  }
  const normalized = normalizeProcessName(token, { stripInterpreterScriptExtension: true })
  const markers = NODE_PACKAGE_SCRIPT_ENTRYPOINTS[normalized]
  if (!markers) {
    return null
  }
  if (!markers.some((marker) => path.includes(marker))) {
    return null
  }
  return recognizedAgentForProcess(normalized)
}

function recognizePythonModule(
  moduleName: string | null | undefined
): RecognizedAgentProcess | null {
  if (!moduleName || moduleName.startsWith('-')) {
    return null
  }
  const normalized = moduleName.split('.', 1)[0]?.toLowerCase() ?? ''
  return recognizedAgentForProcess(normalized)
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
  return recognizedAgentForProcess(normalized)
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

// Hermes' installed launcher execs `python -I -c '<bootstrap>'` (hermes_cli/_launchers.py), so argv names no hermes entrypoint.
function isHermesInlineBootstrap(tokens: readonly string[], firstNormalized: string): boolean {
  if (!PYTHON_PROCESS_RE.test(firstNormalized)) {
    return false
  }
  let index = 1
  while (index < tokens.length && tokens[index] !== '-c') {
    if (tokens[index] === '-X' || tokens[index] === '-W') {
      index += 2
    } else if (/^-[bBdEiIOqRsSuvx]+$/.test(tokens[index])) {
      index += 1
    } else {
      return false
    }
  }
  // ps flattens argv, so the -c program runs to the end of the line there.
  return /\bimport hermes_bootstrap\b/.test(tokens.slice(index + 1).join(' '))
}

// Muse's versioned binary needs a scoped prefix match; generic suffix matching would misclassify names such as ante-obsidian.
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
    normalizedProcess.startsWith(`${normalizedExpected}.`) ||
    (['qoderclicn', 'qodercn'].includes(normalizedExpected) &&
      /^(?:qoderclicn|qodercn)(?:-\d.*)?$/.test(normalizedProcess)) ||
    (['qoder', 'qodercli'].includes(normalizedExpected) &&
      /^(?:qoder|qodercli(?:-\d.*)?)$/.test(normalizedProcess)) ||
    (normalizedExpected === 'muse' && normalizedProcess.startsWith('muse-bin-'))
  )
}

/** Agents whose process names (orca, acli, cn, vibe) also belong to ordinary tools. */
export const GENERIC_PROCESS_NAME_AGENTS: ReadonlySet<TerminalAgent> = new Set([
  'claude-agent-teams',
  'rovo',
  'continue',
  'mistral-vibe'
])

export function recognizeAgentProcess(
  processName: string | null | undefined
): RecognizedAgentProcess | null {
  const normalized = normalizeProcessName(processName)
  return recognizedAgentForProcess(normalized)
}

export function recognizeAgentProcessFromCommandLine(
  commandLine: string | null | undefined,
  // TUI status/shadows exclude headless one-shots; non-interactivity guards include them because they cannot answer prompts.
  options?: { includeHeadlessOneShot?: boolean }
): RecognizedAgentProcess | null {
  if (!commandLine) {
    return null
  }
  if (isFreshOmpLaunchCommand(commandLine)) {
    return recognizedAgentForProcess('omp')
  }
  const keep = options?.includeHeadlessOneShot === true
  const tokens = tokenizeCommandLine(commandLine)
  const firstNormalized = normalizeProcessName(tokens[0])
  let direct = recognizedAgentForProcess(firstNormalized)
  // Qoder's public dispatcher routes these commands to the IDE rather than the agent CLI.
  if (firstNormalized === 'qoder' && tokens[1] && !tokens[1].startsWith('-')) {
    return null
  }
  // Why: the generic Orca CLI is not an agent; only this subcommand launches its TUI mode.
  if (direct?.agent === 'claude-agent-teams' && tokens[1]?.toLowerCase() !== 'claude-teams') {
    direct = null
  }
  const directRecognition = keep ? direct : filterHeadlessOneShotAgentCommand(direct, tokens)
  if (directRecognition) {
    return directRecognition
  }
  if (isHermesInlineBootstrap(tokens, firstNormalized)) {
    return recognizedAgentForProcess('hermes')
  }
  const entrypoint = findInterpreterEntrypointToken(tokens, firstNormalized)
  if (!entrypoint) {
    return null
  }
  const viaEntrypoint = PYTHON_PROCESS_RE.test(firstNormalized)
    ? recognizePythonEntrypoint(tokens, entrypoint)
    : (recognizeAgentProcess(entrypoint) ?? recognizeNodeScriptEntrypoint(entrypoint))
  if (
    viaEntrypoint?.agent === 'claude-agent-teams' &&
    tokens[tokens.indexOf(entrypoint, 1) + 1]?.toLowerCase() !== 'claude-teams'
  ) {
    return null
  }
  return keep ? viaEntrypoint : filterHeadlessOneShotAgentCommand(viaEntrypoint, tokens)
}
export function isAgentForegroundWrapperProcess(processName: string | null | undefined): boolean {
  const normalized = normalizeProcessName(processName)
  return (
    FOREGROUND_AGENT_WRAPPER_PROCESS_NAMES.has(normalized) || PYTHON_PROCESS_RE.test(normalized)
  )
}

/** True when `processName` is the Node interpreter of an npm-installed agent (npm Codex's `node codex.js` wrapper). */
export function isNodeInterpreterOfAgent(
  processName: string | null | undefined,
  agent: TerminalAgent
): boolean {
  return (
    normalizeProcessName(processName) === 'node' &&
    (agent in NODE_PACKAGE_SCRIPT_ENTRYPOINTS ||
      EXACT_NODE_ENTRYPOINT_IDENTITIES.some((identity) => identity.agent === agent))
  )
}

export function isRecognizedAgentType(agentType: AgentType | null | undefined): boolean {
  if (typeof agentType !== 'string') {
    return false
  }
  return (
    AGENT_TYPE_IDS.has(agentType) ||
    agentForNormalizedProcess(normalizeProcessName(agentType)) !== undefined
  )
}
