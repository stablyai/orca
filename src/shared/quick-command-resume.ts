import {
  flattenTerminalQuickCommand,
  terminalQuickCommandMatchesRepo
} from './terminal-quick-commands'
import type { TerminalQuickCommand } from './terminal-quick-command-types'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'

/**
 * Why this file exists: a terminal-command Quick Command can launch an agent
 * CLI through a user wrapper (e.g. `ccr muse --resume` instead of bare
 * `claude`). The tab persists only the label, and every resume path rebuilds
 * the stock agent command — so the restored tab silently lands on the wrong
 * account/route. Resolving the CURRENT command text at resume time (not a
 * snapshot at launch time) means user edits to the Quick Command propagate.
 *
 * Fail-open by design: null means "no usable Quick Command found" and every
 * caller falls back to today's stock-command path, byte for byte.
 */
/**
 * Why: persisted refs must never poison hydration. Labels are user-typed, and
 * the sleeping-record schema drops the WHOLE record (not just the ref) when a
 * ref carries control chars — so a weird label would cost the resume handle
 * entirely. Validate at capture; the schema stays strict.
 */
export function isPersistableQuickCommandRef(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 80) {
    return false
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

// Why `--resume` only: `--continue` is an everyday flag in saved commands
// (`git rebase --continue`, `git merge --continue`) and would stamp them.
const WRAPPER_RESUME_SELECTOR_RE = /^--resume(=.*)?$/
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

function splitCommandTokens(command: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (quote) {
      token += char
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      token += char
      continue
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token)
        token = ''
      }
      continue
    }
    token += char
  }
  if (token) {
    tokens.push(token)
  }
  return tokens
}

function stripTokenQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token.at(0)
    const last = token.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1)
    }
  }
  return token
}

/**
 * Why: the resume ref must only ever be carried for tabs that actually
 * launched an agent CLI. A plain `git status` Quick Command tab sets the same
 * tab label, and if the user later starts an agent by hand in that pane the
 * stale label would rebuild `git status --resume <sid>`. Gate the stamp at
 * launch: the command must either name a known agent binary in command
 * position or already carry a resume selector (only agent commands do).
 */
// Why: derived from TUI_AGENT_CONFIG's own detectCmd/aliases (first tokens of
// launchCmd included, wrapper verbs like `orca claude-teams` excluded — the
// ref is only for shell-typed wrappers around a real agent binary). `ccr`
// (claude-code-router) is the motivating wrapper: its first arg is the
// preset, so bare `ccr` alone must NOT qualify — only with a resume
// selector, which only agent sessions carry.
const KNOWN_AGENT_BINARIES: ReadonlySet<string> = new Set([
  'claude',
  'codebuddy',
  'cbc',
  'openclaude',
  'codex',
  'autohand',
  'ante',
  'traecli',
  'opencode',
  'opencode2',
  'mimo',
  'pi',
  'omp',
  'prime-agent',
  'qodercli',
  'gemini',
  'agy',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro-cli',
  'crush',
  'auggie',
  'cline',
  'freebuff',
  'codebuff',
  'command-code',
  'cursor-agent',
  'droid',
  'kimi',
  'kimi-code',
  'vibe',
  'mistral-vibe',
  'qwen',
  'rovo',
  'hermes',
  'openclaw',
  'copilot',
  'grok',
  'muse',
  'dsh-tui',
  'dst',
  'zcode',
  'devin'
])

/**
 * Why: `NAME=value` assignments before the command (`CLAUDE_CONFIG_DIR=~/.cw
 * claude`) are environment, not the program; callers that identify the
 * program must look past them.
 */
export function stripLeadingEnvAssignments(command: string): string {
  const tokens = splitCommandTokens(command)
  const commandIndex = tokens.findIndex((token) => !ENV_ASSIGNMENT_RE.test(token))
  return commandIndex <= 0 ? command : tokens.slice(commandIndex).join(' ')
}

export function isAgentLikeQuickCommandText(
  command: string,
  // Why: shells without OSC 133 (cmd.exe) never report the command finishing,
  // so an unused stamp can't be retired there; require the agent binary.
  options: { requireAgentBinary?: boolean } = {}
): boolean {
  const tokens = splitCommandTokens(command)
  // Why: leading `NAME=value` assignments (`CLAUDE_CONFIG_DIR=~/.cw claude`)
  // are environment for the command, never the command itself.
  const commandIndex = tokens.findIndex((token) => !ENV_ASSIGNMENT_RE.test(token))
  if (commandIndex === -1) {
    return false
  }
  const firstBasename =
    stripTokenQuotes(tokens[commandIndex]).split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (!firstBasename) {
    return false
  }
  for (const name of KNOWN_AGENT_BINARIES) {
    if (firstBasename === name || firstBasename === `${name}.exe`) {
      return true
    }
  }
  if (options.requireAgentBinary) {
    return false
  }
  // Why the long form only: short `-r` is an everyday flag (`grep -r`,
  // `cp -r`) and would stamp plain shell commands as agents. An explicit
  // `--resume` is how any wrapper or script opts in.
  return tokens.some((token) => WRAPPER_RESUME_SELECTOR_RE.test(stripTokenQuotes(token)))
}

/**
 * Why: the launch-time stamp carries only the Quick Command ref, with empty
 * placeholder args/env. A config that recorded a stock agentCommand holds
 * real launch inputs; a stamp-only one must not suppress the user's defaults
 * when the wrapper cannot be used.
 */
export function isQuickCommandStampOnlyLaunchConfig(
  config: SleepingAgentLaunchConfig | undefined
): boolean {
  return Boolean(
    config && !config.agentCommand?.trim() && (config.quickCommandId || config.quickCommandLabel)
  )
}

export function resolveQuickCommandResumeText(
  quickCommands: readonly TerminalQuickCommand[] | null | undefined,
  ref: { quickCommandId?: string | null; quickCommandLabel?: string | null } | null | undefined,
  repoId?: string | null
): string | null {
  if (!ref || !Array.isArray(quickCommands) || quickCommands.length === 0) {
    return null
  }
  const id = ref.quickCommandId?.trim()
  const label = ref.quickCommandLabel?.trim()
  if (!id && !label) {
    return null
  }
  const inScope =
    repoId != null
      ? quickCommands.filter((command) => terminalQuickCommandMatchesRepo(command, repoId))
      : quickCommands
  // Why id first: the id is stable across edits of the command body, while
  // labels are not unique.
  const byId = id ? inScope.find((command) => command.id === id) : undefined
  // Why: UI-created ids are unique UUIDs, so a stored id that no longer
  // resolves means the command was deleted — a same-label replacement is a
  // different command, not a rename. Only label-only refs use the label.
  if (id && !byId) {
    return null
  }
  // Why uniqueness on the label path: a label-only ref must never pick one of
  // several same-label commands (possibly scoped to another repo) at random —
  // ambiguity resolves to the stock fallback, not a guess.
  const byLabel = !byId && label ? inScope.filter((command) => command.label === label) : []
  const match = byId ?? (byLabel.length === 1 ? byLabel[0] : undefined)
  if (!match || match.action === 'agent-prompt') {
    return null
  }
  // Why: multiline commands flatten to `a; b` shell lists, and a resume
  // selector appended at the end would attach to the LAST command instead of
  // the agent. Compound wrappers are not resume-safe — stock fallback.
  if (/[\r\n]/.test(match.command)) {
    return null
  }
  const text = flattenTerminalQuickCommand(match).command.trim()
  // Why: the text is resolved live, so a linked command later edited into a
  // non-agent one (`./deploy.sh`) must not be re-run on restore.
  return text && isAgentLikeQuickCommandText(text) ? text : null
}

// Same selector shapes the claude resume guard strips
// (agent-resume-launch-command.ts): exact `--resume`/`--continue`/`-r`/`-c`
// and their `=` forms. The ambiguous joined `-r<id>` form is deliberately
// NOT matched — see the guard for why no arity table can cover it.
const STALE_RESUME_SELECTOR_RE = /^(--resume|--continue|-r|-c)(=.*)?$/
const LONG_STALE_RESUME_SELECTOR_RE = /^(--resume|--continue)(=.*)?$/

export type StaleResumeSelectorTarget = {
  /** Executable name of the agent (`claude`, `codex`, `dsh-tui`). Selectors
   *  are only cut after it, so a preceding wrapper's own `-c`/`-r`
   *  (`nix develop -c claude`) survive. */
  agentBinary?: string
  /** The agent's own resume selector for non-claude agents: a flag
   *  (`--resume`, `--session`) or a subcommand (`resume`). Absent = claude. */
  resumeFlag?: string
  /** The agent only accepts the joined `--resume=<id>` form (copilot), so a
   *  bare flag is not followed by a session-id operand. */
  resumeFlagJoined?: boolean
}

function tokenNamesBinary(token: string, binary: string): boolean {
  const basename = token.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return basename === binary || basename === `${binary}.exe`
}

type SelectorMatch = { takesOperand: boolean; consumesRest: boolean } | null

function matchStaleSelector(
  token: string,
  previousToken: string | undefined,
  target: StaleResumeSelectorTarget,
  afterAgentBinary: boolean
): SelectorMatch {
  const flag = target.resumeFlag
  if (flag && !flag.startsWith('-')) {
    // Why: without the binary in the text, `resume` right after an option is
    // that option's value (`wrap --profile resume`), not the subcommand.
    if (token !== flag || (!afterAgentBinary && previousToken?.startsWith('-'))) {
      return null
    }
    // Why: a subcommand resume (`codex resume --last`) owns every following
    // token; leaving them would hoist subcommand options to the top level.
    return { takesOperand: false, consumesRest: true }
  }
  if (flag) {
    if (token === flag) {
      return { takesOperand: target.resumeFlagJoined !== true, consumesRest: false }
    }
    // Why: agents that resume by flag also honor a bare `--continue` (dsh,
    // codebuddy, omp); leaving it would compete with the appended selector.
    return token.startsWith(`${flag}=`) || token === '--continue'
      ? { takesOperand: false, consumesRest: false }
      : null
  }
  // Why: without the agent binary in the text (`ccr muse --resume`), short
  // `-c`/`-r` may belong to the wrapper, so only long forms are selectors.
  const selectorRe = afterAgentBinary ? STALE_RESUME_SELECTOR_RE : LONG_STALE_RESUME_SELECTOR_RE
  if (!selectorRe.test(token)) {
    return null
  }
  return { takesOperand: token === '--resume' || token === '-r', consumesRest: false }
}

/**
 * Why: `buildAgentResumeStartupPlan` appends the resume selector at the END of
 * the wrapper text. After shell syntax (`ccr muse --resume && notify`) that
 * attaches to the LAST command, not the agent — same hazard as the multiline
 * rejection above. Operators, expansions, comments and cmd single-quote
 * regions are exactly the spans the tokenizer flags `divergesFromShell`;
 * PowerShell's leading `&` call operator is the one known-safe divergence,
 * mirroring the claude resume guard (agent-resume-launch-command.ts).
 */
export function isWrapperTextSafeToAppendResume(
  command: string,
  shell: AgentStartupShell
): boolean {
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    return false
  }
  const { tokens, spans } = tokenized
  for (let i = 0; i < spans.length; i += 1) {
    const isCallOperator = shell === 'powershell' && i === 0 && tokens[i] === '&'
    if (spans[i].divergesFromShell && !isCallOperator) {
      return false
    }
    // Why: a bare `--%` makes PowerShell pass the rest of the line to the
    // child literally, so the appended selector would arrive as literal bytes.
    if (shell === 'powershell' && command.slice(spans[i].start, spans[i].end) === '--%') {
      return false
    }
  }
  return true
}

/**
 * Why: a wrapper Quick Command can carry a stale or bare resume selector
 * (`ccr muse --resume old-session`, or a bare `--resume` picker default).
 * That selector can never compete with the authoritative provider session id
 * the resume path appends (#12982), and the claude guard cannot strip it —
 * it only recognizes a `claude` executable token, which wrappers lack — so a
 * wrapper would end up with TWO competing selectors. Strip here instead.
 *
 * Fails open: unmodelable text (operators, expansions, unterminated quotes)
 * returns byte-for-byte untouched.
 */
export function stripStaleResumeSelectors(
  command: string,
  shell: AgentStartupShell,
  target: StaleResumeSelectorTarget = {}
): string {
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    return command
  }
  const { tokens, spans } = tokenized
  // Why: same splice-safety rules as the claude guard — the text between
  // tokens must be plain whitespace, AND any token the tokenizer cannot model
  // for this shell (operator, expansion, comment, cmd single-quoted region)
  // means cutting spans could delete live shell syntax — the operand
  // absorption below would swallow it as if it were the stale session id.
  for (let i = 0; i <= tokens.length; i += 1) {
    const gapStart = i === 0 ? 0 : spans[i - 1].end
    const gapEnd = i === tokens.length ? command.length : spans[i].start
    if (!/^[ \t]*$/.test(command.slice(gapStart, gapEnd))) {
      return command
    }
    if (i < tokens.length) {
      const isCallOperator = shell === 'powershell' && i === 0 && tokens[i] === '&'
      if (spans[i].divergesFromShell && !isCallOperator) {
        return command
      }
      // Why: a bare `--%` makes PowerShell pass the rest of the line to the
      // child literally, so a later selector is not selectors at all.
      if (shell === 'powershell' && command.slice(spans[i].start, spans[i].end) === '--%') {
        return command
      }
    }
  }
  let agentIndex = -1
  for (let i = tokens.length - 1; i >= 0 && target.agentBinary; i -= 1) {
    if (tokenNamesBinary(tokens[i], target.agentBinary)) {
      agentIndex = i
      break
    }
  }
  const cuts: { start: number; end: number }[] = []
  for (let i = agentIndex + 1; i < tokens.length; i += 1) {
    const match = matchStaleSelector(tokens[i], tokens[i - 1], target, agentIndex !== -1)
    if (!match) {
      continue
    }
    let endIndex = i
    const next = tokens[i + 1]
    if (match.consumesRest) {
      endIndex = tokens.length - 1
    } else if (match.takesOperand && next !== undefined && !next.startsWith('-')) {
      // Why: only `--resume`/`-r` (or the agent's own flag) take a separate
      // session-id operand; `--continue`/`-c` are bare flags. Mirrors the claude guard.
      endIndex = i + 1
    }
    let start = spans[i].start
    const prevEnd = i === 0 ? 0 : spans[i - 1].end
    while (start > prevEnd && ' \t'.includes(command[start - 1])) {
      start -= 1
    }
    cuts.push({ start, end: spans[endIndex].end })
    i = endIndex
  }
  let result = command
  for (let i = cuts.length - 1; i >= 0; i -= 1) {
    result = `${result.slice(0, cuts[i].start)}${result.slice(cuts[i].end)}`
  }
  return result
}
