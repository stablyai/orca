import {
  COMMAND_TOKEN_SCAN_MAX_CHARS,
  getCommandTokenPathBasename
} from '../../shell/command-resolution/command-token-scanner'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

export type LaunchPosition = {
  executable: string
  start: number
  end: number
  invocationStart: number
  hasCallOperator: boolean
  bypassesShellFunction: boolean
  cwd: string | undefined
  env: ReadonlyMap<string, string | undefined>
}

// A literal native argv can fill the Windows command line, even when its executable is short.
const LAUNCH_ARGUMENT_SCAN_MAX_CHARS = 32_767

type Word = { value: string; raw: string; start: number; end: number }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const POWERSHELL_ASSIGNMENT = /^\$env:([A-Za-z_][A-Za-z0-9_]*)=/i

/** Used only by readers that have launch text but no host shell fact. */
export function inferLaunchShell(command: string): AgentStartupShell {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  if (/^[ \t]*(?:&|\$env:|Set-Location[ \t]|Remove-Item[ \t]+Env:)/i.test(prefix)) {
    return 'powershell'
  }
  return /^[ \t]*(?:"?[A-Za-z]:\\|cd[ \t]+\/d[ \t]|set[ \t]+")/i.test(prefix) ? 'cmd' : 'posix'
}

// Read the generated prefix grammar in one pass, stopping at the first executable.
export function readLaunchPosition(
  command: string,
  shell: AgentStartupShell
): LaunchPosition | null {
  const limit = Math.min(command.length, COMMAND_TOKEN_SCAN_MAX_CHARS)
  let cursor = 0
  let cwd: string | undefined
  let bypassesShellFunction = false
  const env = new Map<string, string | undefined>()
  const space = (): void => {
    while (cursor < limit && /[ \t]/.test(command[cursor])) {
      cursor++
    }
  }
  const operator = (...ops: string[]): boolean => {
    space()
    const found = ops.find((op) => cursor + op.length <= limit && command.startsWith(op, cursor))
    if (!found) {
      return false
    }
    cursor += found.length
    return true
  }
  const word = (assignmentLength = 0): Word | null => {
    space()
    const start = cursor
    let quote = ''
    let literal = true
    for (; cursor < limit; cursor++) {
      const ch = command[cursor]
      const next = cursor + 1 < limit ? command[cursor + 1] : ''
      if (ch === '\r' || ch === '\n') {
        return null
      }
      const escape =
        (shell === 'posix' && ch === '\\' && quote !== "'") ||
        (shell === 'powershell' && ch === '`' && quote !== "'") ||
        (shell === 'cmd' && ch === '^' && !quote)
      if (escape && next && !/[\r\n]/.test(next)) {
        cursor++
        continue
      }
      if (quote) {
        if (ch === quote) {
          if (shell === 'powershell' && next === quote) {
            cursor++
          } else {
            quote = ''
          }
        } else if (
          (quote === '"' && shell !== 'cmd' && '`$'.includes(ch)) ||
          (shell === 'cmd' && '%!'.includes(ch))
        ) {
          literal = false
        }
      } else if (ch === '"' || (ch === "'" && shell !== 'cmd')) {
        quote = ch
      } else if (' \t;&|<>(){}'.includes(ch)) {
        break
      } else if (
        cursor >= start + assignmentLength &&
        (shell === 'cmd' ? '%!'.includes(ch) : '$`*?['.includes(ch))
      ) {
        literal = false
      }
    }
    if (!literal || quote || start === cursor || (cursor === limit && limit !== command.length)) {
      return null
    }
    const raw = command.slice(start, cursor)
    const parsed = tokenizeStartupCommand(raw.slice(assignmentLength) || "''", shell, true)
    return parsed.ok && parsed.tokens.length === 1 && !parsed.spans[0].divergesFromShell
      ? { value: parsed.tokens[0], raw, start, end: cursor }
      : null
  }

  while (cursor < limit) {
    space()
    const assignment =
      shell === 'powershell'
        ? POWERSHELL_ASSIGNMENT.exec(command.slice(cursor, Math.min(cursor + 256, limit)))
        : null
    if (assignment) {
      const value = word(assignment[0].length)
      if (!value || !operator(';')) {
        return null
      }
      env.set(assignment[1], value.value)
      continue
    }
    const invocationStart = cursor
    const hasCallOperator = shell === 'powershell' && operator('&')
    const head = word()
    if (!head) {
      return null
    }
    const builtin = shell === 'posix' ? head.raw : head.raw.toLowerCase()
    if (
      !hasCallOperator &&
      (builtin === 'cd' || (shell === 'powershell' && builtin === 'set-location'))
    ) {
      if (cwd) {
        return null
      }
      const option = shell === 'powershell' ? '-literalpath' : shell === 'cmd' ? '/d' : null
      if (option && word()?.raw.toLowerCase() !== option) {
        return null
      }
      let dir = word()
      if (shell === 'posix' && dir?.raw === '--') {
        dir = word()
      }
      if (!dir?.value || !operator(shell === 'powershell' ? ';' : '&&')) {
        return null
      }
      cwd = dir.value
      continue
    }
    if (shell === 'powershell' && !hasCallOperator && builtin === 'remove-item') {
      const target = /^Env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(word()?.raw ?? '')
      if (
        !target ||
        word()?.raw.toLowerCase() !== '-erroraction' ||
        word()?.raw.toLowerCase() !== 'silentlycontinue' ||
        !operator(';')
      ) {
        return null
      }
      env.set(target[1], undefined)
      continue
    }
    if (shell === 'cmd' && builtin === 'set') {
      const assignmentWord = word()
      const name = ASSIGNMENT.exec(assignmentWord?.value ?? '')?.[0]
      if (!assignmentWord || !name || !operator('&&', '&')) {
        return null
      }
      env.set(name.slice(0, -1), assignmentWord.value.slice(name.length) || undefined)
      continue
    }
    let target = head
    if (shell === 'posix') {
      while (ASSIGNMENT.test(target.raw)) {
        const equals = target.value.indexOf('=')
        env.set(target.value.slice(0, equals), target.value.slice(equals + 1))
        const next = word()
        if (!next) {
          return null
        }
        target = next
      }
      while (target.raw === 'command') {
        const next = word()
        if (!next || next.value.startsWith('-')) {
          return null
        }
        bypassesShellFunction = true
        target = next
      }
      if (target.raw === 'env' || target.raw === 'exec') {
        const isEnv = target.raw === 'env'
        bypassesShellFunction = true
        let next = word()
        let seenAssignment = false
        while (isEnv && next) {
          if (!seenAssignment && next.raw === '-u') {
            const name = word()
            if (!name || !NAME.test(name.raw)) {
              return null
            }
            env.set(name.value, undefined)
          } else if (ASSIGNMENT.test(next.raw)) {
            seenAssignment = true
            const equals = next.value.indexOf('=')
            env.set(next.value.slice(0, equals), next.value.slice(equals + 1))
          } else {
            break
          }
          next = word()
        }
        if (!next || next.value.startsWith('-')) {
          return null
        }
        target = next
      }
    }
    return target.value
      ? {
          executable: target.value,
          start: target.start,
          end: target.end,
          invocationStart,
          hasCallOperator,
          bypassesShellFunction,
          cwd,
          env
        }
      : null
  }
  return null
}

export function readLaunchArguments(
  command: string,
  shell: AgentStartupShell,
  launch: LaunchPosition
): string[] | null {
  if (command.length > LAUNCH_ARGUMENT_SCAN_MAX_CHARS) {
    return null
  }
  const suffix = command.slice(launch.end)
  const parsed = tokenizeStartupCommand(suffix, shell, true)
  return parsed.ok && !parsed.spans.some((span) => span.divergesFromShell) && !/[\r\n]/.test(suffix)
    ? parsed.tokens
    : null
}

export function launchExecutableIs(program: string, name: RegExp): boolean {
  return name.test(getCommandTokenPathBasename(program))
}
