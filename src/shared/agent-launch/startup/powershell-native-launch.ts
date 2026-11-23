import {
  getPowerShellEscapeNativeArgsFunction,
  isPowerShellSingleQuote,
  quotePowerShellLiteral
} from '../../shell/launch/powershell-native-argument'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import { readLaunchPosition, type LaunchPosition } from './launch-position'

const SCRIPT_HEAD = /& \{ (\$orcaProgram = |param\(\$orcaProgram\); )/
const SCRIPT_END = ' } --'
const INVOCATION = '& $orcaProgram @orcaNativeArgs'
const ESCAPE_FUNCTION = getPowerShellEscapeNativeArgsFunction({ inline: true })
const CODE_CHARS = '$@;|&(){}<>#'
const DOUBLE_QUOTES = '"\u201C\u201D\u201E'

type CommaWord = { start: number; end: number; bareComma: boolean; quoted: boolean }

/** Splits the tail into PowerShell words (ASCII and smart quotes), noting commas and code outside quotes. */
function readPowerShellWords(tail: string): { words: CommaWord[]; code: boolean } | null {
  const words: CommaWord[] = []
  let code = false
  let quote: 'single' | 'double' | null = null
  let word: CommaWord | null = null
  for (let index = 0; index < tail.length; index += 1) {
    const char = tail[index]
    if (!quote && /\s/.test(char)) {
      // A line break starts another statement.
      code ||= char === '\n' || char === '\r'
      if (word) {
        word.end = index
        words.push(word)
        word = null
      }
      continue
    }
    word ??= { start: index, end: tail.length, bareComma: false, quoted: false }
    if (quote === 'single') {
      if (isPowerShellSingleQuote(char)) {
        if (isPowerShellSingleQuote(tail[index + 1] ?? '')) {
          index += 1
        } else {
          quote = null
        }
      }
    } else if (char === '`') {
      code ||= !quote
      index += 1
    } else if (quote === 'double') {
      // Expansion inside double quotes can hold nested quoting this scan does not model.
      if (char === '$') {
        return null
      }
      if (DOUBLE_QUOTES.includes(char)) {
        if (index + 1 < tail.length && DOUBLE_QUOTES.includes(tail[index + 1])) {
          index += 1
        } else {
          quote = null
        }
      }
    } else if (isPowerShellSingleQuote(char)) {
      quote = 'single'
      word.quoted = true
    } else if (DOUBLE_QUOTES.includes(char)) {
      quote = 'double'
      word.quoted = true
    } else if (char === ',') {
      word.bareComma = true
    } else {
      code ||= CODE_CHARS.includes(char)
    }
  }
  if (quote) {
    return null
  }
  if (word) {
    words.push(word)
  }
  return { words, code }
}

/** A quoted a,b is already one argument; quote a plain a,b word only on a line with no code outside quotes,
 * and leave any other bare comma to PowerShell. */
function quoteCommaWords(tail: string): string | null {
  const read = readPowerShellWords(tail)
  if (!read) {
    return null
  }
  const { words, code } = read
  let out = ''
  let end = 0
  for (const { start, end: wordEnd, bareComma, quoted } of words) {
    if (!bareComma) {
      continue
    }
    if (code || quoted) {
      return null
    }
    out += tail.slice(end, start) + quotePowerShellLiteral(tail.slice(start, wordEnd))
    end = wordEnd
  }
  return out + tail.slice(end)
}

/** A bare --% stops PowerShell parsing; a quoted '--%' is only data. */
export function hasPowerShellStopParsing(command: string, launch: LaunchPosition): boolean {
  const tail = command.slice(launch.end)
  if (!tail.includes('--%')) {
    return false
  }
  const read = readPowerShellWords(tail)
  return (
    !read || read.words.some((word) => !word.quoted && tail.slice(word.start, word.end) === '--%')
  )
}

export function powerShellNativeLaunch(
  command: string,
  launch: LaunchPosition,
  before = '',
  prependArgs = '',
  after = ''
): string {
  if (hasPowerShellStopParsing(command, launch)) {
    return command
  }
  // A native program gets a bare a,b as one argument but a script block gets an array. Quote plain
  // comma words; leave a bare comma mixed with quoting to PowerShell's own native parsing, unwrapped like --%.
  const tail = command.slice(launch.end)
  const suffix = tail.includes(',') ? quoteCommaWords(tail) : tail
  if (suffix === null) {
    return command
  }
  const escape = `if (-not (Test-Path Function:__OrcaEscapeNativeArgs)) { ${ESCAPE_FUNCTION} }; $orcaNativeArgs = @(__OrcaEscapeNativeArgs $orcaProgram (${prependArgs}@($args))); `
  // PowerShell consumes the first -- for a script block, preserving later -- and leaving flags unbound.
  const program = quotePowerShellLiteral(launch.executable)
  return `${command.slice(0, launch.invocationStart)}& { $orcaProgram = ${program}; ${before}${escape}${INVOCATION}${after}${SCRIPT_END}${suffix}`
}

export function unwrapPowerShellNativeLaunch(command: string): string {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  const head = SCRIPT_HEAD.exec(prefix)
  if (!head) {
    return command
  }
  const start = head.index
  const programStart = start + head[0].length
  const invocation = prefix.indexOf(INVOCATION, programStart)
  if (
    invocation === -1 ||
    (start !== 0 &&
      readLaunchPosition(`${prefix.slice(0, start)}& orca-native-launch`, 'powershell')
        ?.invocationStart !== start)
  ) {
    return command
  }
  const afterInvocation = invocation + INVOCATION.length
  if (head[1] === 'param($orcaProgram); ') {
    const legacyEnd = prefix.indexOf(" } '", afterInvocation)
    return legacyEnd === -1 ? command : command.slice(legacyEnd + 3)
  }
  const end = prefix.indexOf(SCRIPT_END, afterInvocation)
  const program = readLaunchPosition(prefix.slice(programStart), 'powershell')
  return end !== -1 && program
    ? command.slice(programStart, programStart + program.end) +
        command.slice(end + SCRIPT_END.length)
    : command
}
