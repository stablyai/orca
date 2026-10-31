import { describe, expect, it } from 'vitest'
import { quoteStartupArg } from './tui-agent-startup-shell'

/** What cmd hands the child for a typed line with no defined %VAR%: it strips `^` outside double
 *  quotes and keeps it literal inside them, and an unescaped `"` toggles the quoted region. */
function cmdLineAfterCaretPass(line: string): string {
  let output = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      quoted = !quoted
    } else if (char === '^' && !quoted && index + 1 < line.length) {
      index += 1
      output += line[index]
      continue
    }
    output += char
  }
  return output
}

/** The Microsoft C runtime / CommandLineToArgvW split the agent CLI applies to that line. */
function splitWindowsArgv(line: string): string[] {
  const args: string[] = []
  let current = ''
  let started = false
  let quoted = false
  for (let index = 0; index < line.length;) {
    const char = line[index]
    if (char === '\\') {
      let count = 0
      while (line[index + count] === '\\') {
        count += 1
      }
      if (line[index + count] === '"') {
        current += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) {
          current += '"'
          index += count + 1
        } else {
          index += count
        }
      } else {
        current += '\\'.repeat(count)
        index += count
      }
      started = true
    } else if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 2
      } else {
        quoted = !quoted
        index += 1
      }
      started = true
    } else if ((char === ' ' || char === '\t') && !quoted) {
      if (started) {
        args.push(current)
      }
      current = ''
      started = false
      index += 1
    } else {
      current += char
      started = true
      index += 1
    }
  }
  if (started) {
    args.push(current)
  }
  return args
}

function argvAfterCmd(value: string): string[] {
  return splitWindowsArgv(cmdLineAfterCaretPass(`claude ${quoteStartupArg(value, 'cmd')}`))
}

describe('quoteStartupArg for cmd', () => {
  it.each([
    'fix the bug (urgent)!',
    'fix "quoted" & %PATH%',
    '100% done',
    'a | b > c < d ^ e',
    'path C:\\dir\\',
    'ends with \\"',
    'plain words'
  ])('reaches the agent unchanged: %s', (prompt) => {
    expect(argvAfterCmd(prompt)).toEqual(['claude', prompt])
  })

  it('keeps plain values in the simple quoted form', () => {
    expect(quoteStartupArg('session-1', 'cmd')).toBe('"session-1"')
  })

  it('caret-escapes the quotes too, so cmd never treats the escapes as literal', () => {
    expect(quoteStartupArg('fix (it)!', 'cmd')).toBe('^"fix ^(it^)^!^"')
  })
})
