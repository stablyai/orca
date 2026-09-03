// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { language as stockPythonLanguage } from 'monaco-editor/esm/vs/basic-languages/python/python.js'
import {
  patchPythonTripleQuotedFStrings,
  registerPythonLanguage,
  TRIPLE_DOUBLE_QUOTED_F_STRING_STATE
} from './register-python'

type MonarchLanguage = Monaco.languages.IMonarchLanguage
type MonarchRule = [RegExp, unknown, string?] | { include: string }
type Tokenizer = Record<string, MonarchRule[]>

function isRuleEntry(rule: MonarchRule): rule is [RegExp, unknown, string?] {
  return Array.isArray(rule)
}

function resolveAction(rule: [RegExp, unknown, string?]): { token?: string; next?: string } {
  const [, action, nextShortcut] = rule
  if (typeof action === 'object' && action !== null) {
    const structured = action as { token?: string; next?: string }
    return { token: structured.token, next: structured.next ?? nextShortcut }
  }
  return { token: typeof action === 'string' ? action : undefined, next: nextShortcut }
}

/** Flatten `{ include: '@state' }` so rules are tried in Monarch's real order. */
function expandRules(tokenizer: Tokenizer, state: string, seen = new Set<string>()): MonarchRule[] {
  if (seen.has(state)) {
    return []
  }
  seen.add(state)
  const rules = tokenizer[state] ?? tokenizer[state.split('.')[0]] ?? []
  return rules.flatMap((rule) =>
    isRuleEntry(rule) ? [rule] : expandRules(tokenizer, rule.include.replace(/^@/, ''), seen)
  )
}

type Walk = { stateAtLineStart: string[]; tokens: { line: number; text: string; token: string }[] }

/**
 * Walk `source` through the grammar the way Monarch does: longest-prefix rule
 * order, an explicit state stack, and `@push` / `@pop` / `@popall` transitions.
 * Only the subset the Python grammar uses is modelled.
 */
function walk(language: MonarchLanguage, source: string): Walk {
  const tokenizer = language.tokenizer as Tokenizer
  const stack = ['root']
  const stateAtLineStart: string[] = []
  const tokens: { line: number; text: string; token: string }[] = []

  source.split('\n').forEach((line, index) => {
    stateAtLineStart.push(stack.at(-1) ?? 'root')
    let column = 0
    let guard = 0
    while (column < line.length) {
      if (++guard > 500) {
        throw new Error(`tokenizer made no progress on line ${index + 1}`)
      }
      const rest = line.slice(column)
      const current = stack.at(-1) ?? 'root'
      const match = expandRules(tokenizer, current)
        .map((rule) => {
          if (!isRuleEntry(rule)) {
            return null
          }
          const anchored = new RegExp(`^(?:${rule[0].source})`, rule[0].flags.replace(/[gy]/g, ''))
          const found = anchored.exec(rest)
          return found && found[0].length > 0 ? { rule, text: found[0] } : null
        })
        .find((candidate) => candidate !== null)

      if (!match) {
        column += 1
        continue
      }

      const { token, next } = resolveAction(match.rule)
      tokens.push({ line: index + 1, text: match.text, token: token ?? '' })
      column += match.text.length

      if (next === '@popall') {
        stack.splice(1)
      } else if (next === '@pop') {
        if (stack.length > 1) {
          stack.pop()
        }
      } else if (next?.startsWith('@')) {
        stack.push(next.slice(1))
      }
    }
  })

  return { stateAtLineStart, tokens }
}

// The issue's exact minimal reproduction (STA-5792).
const FIXTURE = ['x = f"""', 'SELECT 1', '"""', '', 'with open("f.txt") as dag:', '    pass'].join(
  '\n'
)

const patchedPython = patchPythonTripleQuotedFStrings(stockPythonLanguage)

describe('python triple-quoted f-strings', () => {
  it('reproduces the stock grammar defect: code after the f-string is left inside a docstring', () => {
    const { stateAtLineStart } = walk(stockPythonLanguage, FIXTURE)

    // The body line pops to root, so the closing `"""` reads as an *opening* docstring.
    expect(stateAtLineStart[2]).toBe('root')
    expect(stateAtLineStart[4]).toBe('endDblDocString')
  })

  it('keeps a triple-quoted f-string open and returns to root after it closes', () => {
    const { stateAtLineStart } = walk(patchedPython, FIXTURE)

    expect(stateAtLineStart[0]).toBe('root')
    expect(stateAtLineStart[1]).toBe(TRIPLE_DOUBLE_QUOTED_F_STRING_STATE)
    expect(stateAtLineStart[2]).toBe(TRIPLE_DOUBLE_QUOTED_F_STRING_STATE)
    // Closing delimiter returns to root instead of opening a docstring.
    expect(stateAtLineStart[4]).toBe('root')
  })

  it('tokenizes code after the f-string as keywords rather than one flat string', () => {
    const { tokens } = walk(patchedPython, FIXTURE)
    const afterFString = tokens.filter((entry) => entry.line === 5)

    expect(afterFString.length).toBeGreaterThan(1)
    expect(afterFString.every((entry) => entry.token.startsWith('string'))).toBe(false)
    expect(afterFString.some((entry) => entry.text === 'with')).toBe(true)
  })

  it("applies the same fix to f'''", () => {
    const { stateAtLineStart } = walk(
      patchedPython,
      ["x = f'''", 'SELECT 1', "'''", 'class Runner:'].join('\n')
    )

    expect(stateAtLineStart[1]).toBe('fTripleStringBody')
    expect(stateAtLineStart[3]).toBe('root')
  })

  it('leaves single-line and plain triple-quoted strings alone', () => {
    const singleLine = walk(patchedPython, ['a = f"""SELECT 1"""', 'class Runner:'].join('\n'))
    expect(singleLine.stateAtLineStart[1]).toBe('root')

    const docstring = walk(
      patchedPython,
      ['b = """', 'SELECT 1', '"""', 'class Runner:'].join('\n')
    )
    expect(docstring.stateAtLineStart[3]).toBe('root')

    const interpolated = walk(
      patchedPython,
      ['c = f"""', 'SELECT {table}', '"""', 'class Runner:'].join('\n')
    )
    expect(interpolated.stateAtLineStart[3]).toBe('root')
  })

  it('keeps a backslash line-continuation inside the f-string a string token', () => {
    const source = ['x = f"""', 'SELECT 1 \\', 'FROM t', '"""', 'class Runner:'].join('\n')
    const { stateAtLineStart, tokens } = walk(patchedPython, source)

    // The trailing backslash must not fall through to the default token.
    const continuation = tokens.filter((entry) => entry.line === 2)
    expect(continuation.at(-1)?.text).toBe('\\')
    expect(continuation.at(-1)?.token).toBe('string')
    expect(stateAtLineStart[2]).toBe(TRIPLE_DOUBLE_QUOTED_F_STRING_STATE)
    expect(stateAtLineStart[4]).toBe('root')
  })

  it('does not mutate the stock grammar it patches', () => {
    const stockStrings = (stockPythonLanguage.tokenizer as Tokenizer).strings
    expect(stockStrings.some((rule) => isRuleEntry(rule) && rule[0].source === 'f"""')).toBe(false)
    expect((stockPythonLanguage.tokenizer as Tokenizer)[TRIPLE_DOUBLE_QUOTED_F_STRING_STATE]).toBe(
      undefined
    )
  })

  it('replaces the built-in Python tokenizer factory lazily', async () => {
    const registerTokensProviderFactory = vi.fn()
    registerPythonLanguage({
      languages: { registerTokensProviderFactory }
    } as unknown as typeof Monaco)

    expect(registerTokensProviderFactory).toHaveBeenCalledTimes(1)
    expect(registerTokensProviderFactory.mock.calls[0][0]).toBe('python')

    const factory = registerTokensProviderFactory.mock.calls[0][1] as {
      create: () => Promise<MonarchLanguage>
    }
    const created = (await factory.create()).tokenizer as Tokenizer
    expect(created[TRIPLE_DOUBLE_QUOTED_F_STRING_STATE]).toBeDefined()
  })
})
