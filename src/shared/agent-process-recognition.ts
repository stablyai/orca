import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from './tui-agent-config'
import { EXACT_NODE_ENTRYPOINT_IDENTITIES } from './agent-node-entrypoint-identities'
import type { AgentType } from './agent-status-types'
import type { TuiAgent } from './tui-agent'
import { filterHeadlessOneShotAgentCommand } from './agent-headless-command'
import { getFirstCommandToken } from './command-token-scanner'
import {
  comparablePath,
  findInterpreterEntrypointToken,
  PYTHON_PROCESS_RE,
  tokenizeCommandLine
} from './agent-command-line-entrypoint'
import { isFreshOmpLaunchCommand } from './omp-fresh-launch'

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
  gemini: ['node_modules/@google/gemini-cli/'],
  // Why: ZCode's npm bin is `dist/zcode.cjs`, so a package install runs as `node …zcode.cjs`
  // and never shows `zcode` as the foreground name (a SEA build still matches by name).
  zcode: ['node_modules/@zcode/cli/'],
  bob: ['node_modules/bobshell/']
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
  // Why: the `muse` launcher script execs a versioned `muse-bin-<version>` binary, so
  // the foreground name never equals `muse` itself. The `muse-bin-` prefix also covers
  // comm-truncated rows (`muse-bin-1.0.3-R`) without matching unrelated `muse-*` tools.
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

// Why: `muse` execs a versioned `muse-bin-<version>` binary (see above), so the
// exact-name check never matches and readiness/follow-up delivery would stall.
// Scoped to muse: a generic `-suffix` rule would misclassify short agent names
// (see the ante-obsidian test).
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
    (normalizedExpected === 'muse' && normalizedProcess.startsWith('muse-bin-'))
  )
}

export function recognizeAgentProcess(
  processName: string | null | undefined
): RecognizedAgentProcess | null {
  const normalized = normalizeProcessName(processName)
  return recognizedAgentForProcess(normalized)
}

export function recognizeAgentProcessFromCommandLine(
  commandLine: string | null | undefined,
  // Why: TUI consumers (status hooks, shell shadows) filter out headless
  // one-shots (`claude -p …`); non-interactivity guards include them — a
  // one-shot agent can't answer a prompt either.
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
  // Why: the generic Orca CLI is not an agent; only this subcommand launches its TUI mode.
  if (direct?.agent === 'claude-agent-teams' && tokens[1]?.toLowerCase() !== 'claude-teams') {
    direct = null
  }
  const directRecognition = keep ? direct : filterHeadlessOneShotAgentCommand(direct, tokens)
  if (directRecognition) {
    return directRecognition
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

export function isRecognizedAgentType(agentType: AgentType | null | undefined): boolean {
  if (typeof agentType !== 'string') {
    return false
  }
  return (
    AGENT_TYPE_IDS.has(agentType as TuiAgent) ||
    agentForNormalizedProcess(normalizeProcessName(agentType)) !== undefined
  )
}
