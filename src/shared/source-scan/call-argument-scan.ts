import { stripComments } from './source-tree-scan'

const CLOSER_BY_OPENER: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** Top-level argument texts of the call whose `(` ends at `start`; quote-aware, not a parser. */
export function splitCallArguments(source: string, start: number): string[] {
  const args: string[] = []
  const closers: string[] = [')']
  let current = ''
  let quote: string | null = null
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      current += char
      if (char === '\\') {
        current += source[index + 1] ?? ''
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    const closer = CLOSER_BY_OPENER[char]
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (closer) {
      closers.push(closer)
    } else if (char === closers.at(-1)) {
      closers.pop()
      if (closers.length === 0) {
        break
      }
    } else if (char === ',' && closers.length === 1) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) {
    args.push(current.trim())
  }
  return args
}

export type RequiredCallArgument = {
  /** Which positional argument must be present. */
  index: number
  /** The call counts only when the text before `.method(` matches, e.g. its receiver. */
  receiver?: RegExp
  /** When the argument is an object literal, whether it carries the required field. */
  acceptsObjectLiteral?: (literal: string) => boolean
}

/**
 * `line: .method(args)` for each call that leaves out a required argument. For code the compiler
 * cannot check, such as `@ts-nocheck` files and `any`-typed receivers.
 */
export function findCallsMissingArgument(
  source: string,
  requiredByMethod: Record<string, RequiredCallArgument>
): string[] {
  const code = stripComments(source)
  const callRe = new RegExp(`\\.\\s*(${Object.keys(requiredByMethod).join('|')})\\s*\\(`, 'g')
  const missing: string[] = []
  for (const match of code.matchAll(callRe)) {
    const method = match[1]!
    const required = requiredByMethod[method]!
    const before = code.slice(0, match.index)
    if (required.receiver && !required.receiver.test(before)) {
      continue
    }
    const args = splitCallArguments(code, match.index + match[0].length)
    const argument = args[required.index]
    const present =
      argument !== undefined &&
      (!argument.startsWith('{') || (required.acceptsObjectLiteral?.(argument) ?? true))
    if (!present) {
      missing.push(`${before.split('\n').length}: .${method}(${args.join(', ')})`)
    }
  }
  return missing
}
