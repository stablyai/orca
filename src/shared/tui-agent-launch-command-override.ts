import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { recognizeAgentProcess } from './agent-process-recognition'
import { getCommandTokenPathBasename } from './command-token-scanner'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import {
  findInterpreterEntrypointToken,
  isInterpreterProcessName
} from './agent-command-line-entrypoint'

type PackageRunner = {
  prefix: readonly string[]
  values: readonly string[]
  switches: readonly string[]
  requiresSeparator?: boolean
}
const NPM_RUNNER_SWITCHES = ['-y', '--yes', '--no', '--no-install', '--quiet', '--offline']
const UV_RUNNER = {
  values: ['-p', '--python', '--from', '--directory'],
  switches: ['--offline', '--no-cache', '--no-project', '--isolated']
}
const PACKAGE_RUNNERS = new Map<string, PackageRunner>([
  ['npx', { prefix: [], values: ['-p', '--package', '--cache'], switches: NPM_RUNNER_SWITCHES }],
  [
    'npm',
    {
      prefix: ['exec'],
      values: [],
      switches: [],
      requiresSeparator: true
    }
  ],
  [
    'bunx',
    {
      prefix: [],
      values: ['-p', '--package'],
      switches: ['--bun', '--silent', '--verbose', '--no-install']
    }
  ],
  ['pnpm', { prefix: ['dlx'], values: ['--package'], switches: ['--silent'] }],
  ['yarn', { prefix: ['dlx'], values: ['-p', '--package'], switches: ['-q', '--quiet'] }],
  ['uvx', { prefix: [], ...UV_RUNNER }],
  ['uv', { prefix: ['tool', 'run'], ...UV_RUNNER }]
])

/** Null means argument ownership is unknown; an empty array means the agent has no arguments. */
export function agentCommandArgumentTokens(
  command: string,
  shell: AgentStartupShell
): string[] | null {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return null
  }
  const { tokens, spans } = parsed
  const callOperator =
    shell === 'powershell' &&
    tokens[0] === '&' &&
    command.slice(spans[0].start, spans[0].end) === '&'
  if (
    spans.some(
      (span, index) =>
        (span.divergesFromShell && !(index === 0 && callOperator)) ||
        !/^[ \t]*$/.test(command.slice(index === 0 ? 0 : spans[index - 1].end, span.start))
    )
  ) {
    return null
  }
  let index = callOperator ? 1 : 0
  let runnerEntrypoint = false
  while (index < tokens.length) {
    if (shell === 'posix' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
      index += 1
      continue
    }
    const executable = getCommandTokenPathBasename(tokens[index])
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|ps1)$/, '')
    if (executable === 'env') {
      index += 1
      while (index < tokens.length) {
        const token = tokens[index]
        if (token === '--') {
          index += 1
          break
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
          index += 1
          continue
        }
        const name = token.split('=', 1)[0]
        if (['-u', '--unset', '-C', '--chdir'].includes(name)) {
          index += token === name ? 2 : 1
          continue
        }
        if (token.startsWith('-')) {
          return null
        }
        break
      }
      continue
    }
    if (executable === 'ssh') {
      index += 1
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const token = tokens[index++]
        if (token === '--') {
          break
        }
        if (/^-[1246AaCfGgKkMNnqsTtVvXxYy]+$/.test(token)) {
          continue
        }
        if (/^-[BbcDEeFIiJLlmOopQRSWw]/.test(token)) {
          index += token.length === 2 ? 1 : 0
          continue
        }
        return null
      }
      // SSH consumes the destination before passing the remaining words to the remote shell.
      index += 1
      continue
    }
    const runner = PACKAGE_RUNNERS.get(executable)
    if (runner) {
      runnerEntrypoint = true
      if (!runner.prefix.every((token, offset) => tokens[index + offset + 1] === token)) {
        return null
      }
      index += runner.prefix.length + 1
      if (runner.requiresSeparator) {
        const separator = tokens.indexOf('--', index)
        if (separator === -1) {
          return null
        }
        index = separator + 1
        continue
      }
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const token = tokens[index]
        if (token === '--') {
          index += 1
          break
        }
        const name = token.split('=', 1)[0]
        if (runner.values.includes(name)) {
          index += token === name ? 2 : 1
        } else if (runner.switches.includes(name)) {
          index += 1
        } else {
          return null
        }
      }
      continue
    }
    if (isInterpreterProcessName(executable)) {
      const entrypoint = findInterpreterEntrypointToken(tokens.slice(index), executable)
      return entrypoint ? tokens.slice(tokens.indexOf(entrypoint, index + 1) + 1) : null
    }
    return runnerEntrypoint || recognizeAgentProcess(executable) ? tokens.slice(index + 1) : null
  }
  return null
}
import { parseAgentCommand } from './agent-command-plan'

/** Literal program and prefix; chat never evaluates shell syntax. */
export function structuredAgentCommandPlan(command: string, platform?: NodeJS.Platform) {
  const input = command.trim()
  if (!input || /[\0\r\n$`]/.test(input)) {
    return null
  }
  const windowsPath = /^(?:["']?)(?:[A-Za-z]:[\\/]|\\\\)/.test(input)
  const parsed = parseAgentCommand(
    '',
    input,
    platform === 'win32' || windowsPath ? 'literal' : 'escape'
  )
  if (
    !parsed.ok ||
    parsed.env ||
    parsed.divergesFromShell ||
    [parsed.binary, ...parsed.prefixArgs].some((token) => /[|&;<>(){}[\]*?!]/.test(token))
  ) {
    return null
  }
  return { program: parsed.binary, prefixArgs: parsed.prefixArgs }
}

/** Terminal-backed chat skips the structured catalog when its launch command is customized. */
export function hasExplicitTuiLaunchCommand(
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> | null | undefined,
  agent: TuiAgent
): boolean {
  return Boolean(settings?.agentCmdOverrides?.[agent]?.trim())
}
