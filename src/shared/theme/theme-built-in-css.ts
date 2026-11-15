// Reads Orca's built-in token values out of main.css text, the way the renderer reads them from
// the live stylesheet (theme-built-in-tokens.ts): custom properties declared by `:root` (light)
// or `:root` then `.dark` (dark), outside media rules, with var() substituted. Self-contained so
// the generator script can run it with plain Node.

type Mode = 'light' | 'dark'

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Declarations directly inside blocks whose selector list names `selector` exactly. */
function collect(css: string, selector: ':root' | '.dark', into: Map<string, string>): void {
  let index = 0
  const walk = (inMatching: boolean, skip: boolean): void => {
    let buffer = ''
    let quote: string | null = null
    let parens = 0
    while (index < css.length) {
      const char = css[index]
      index += 1
      // Why track quotes and parentheses: `url("data:…;…")` holds semicolons and braces.
      if (quote) {
        quote = char === quote ? null : quote
        buffer += char
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        buffer += char
        continue
      }
      if (char === '(' || char === ')') {
        parens += char === '(' ? 1 : -1
        buffer += char
        continue
      }
      if (parens > 0) {
        buffer += char
        continue
      }
      if (char === '{') {
        const prelude = buffer.trim()
        buffer = ''
        if (prelude.startsWith('@')) {
          // Why not media rules: a rule for another screen or scheme is not this mode's built-in.
          // Why keep inMatching: the build nests `@supports` inside `:root` for color-mix values.
          const keeps = /^@(layer|supports)\b/.test(prelude)
          walk(keeps && inMatching, skip || !keeps)
        } else {
          const matches = prelude.split(',').some((part) => part.trim() === selector)
          walk(!skip && matches, skip)
        }
        continue
      }
      if (char === '}') {
        declare(buffer, inMatching)
        return
      }
      if (char === ';') {
        declare(buffer, inMatching)
        buffer = ''
        continue
      }
      buffer += char
    }
  }
  const declare = (text: string, inMatching: boolean): void => {
    const match = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(text)
    if (inMatching && match) {
      into.set(match[1], match[2].replace(/!important\s*$/, '').trim())
    }
  }
  walk(false, false)
}

/** Replaces var(--x, fallback) with the declared value, as a computed custom property does. */
function substitute(
  value: string,
  declared: Map<string, string>,
  seen: Set<string>
): string | null {
  let result = ''
  let index = 0
  while (index < value.length) {
    const start = value.indexOf('var(', index)
    if (start === -1) {
      result += value.slice(index)
      break
    }
    result += value.slice(index, start)
    let depth = 1
    let end = start + 4
    while (end < value.length && depth > 0) {
      if (value[end] === '(') {
        depth += 1
      } else if (value[end] === ')') {
        depth -= 1
      }
      end += 1
    }
    const inner = value.slice(start + 4, end - 1)
    const comma = topLevelComma(inner)
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim()
    const own = declared.get(name)
    const resolved =
      own !== undefined && !seen.has(name)
        ? substitute(own, declared, new Set([...seen, name]))
        : null
    const replacement =
      resolved ?? (fallback === null ? null : substitute(fallback, declared, seen))
    if (replacement === null) {
      return null
    }
    result += replacement
    index = end
  }
  return result.replace(/\s+/g, ' ').trim()
}

function topLevelComma(text: string): number {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1
    } else if (text[index] === ')') {
      depth -= 1
    } else if (text[index] === ',' && depth === 0) {
      return index
    }
  }
  return -1
}

/** Each named token's built-in value per mode; '' when the stylesheet leaves it unset. */
export function themeBuiltInValuesFromCss(
  cssText: string,
  tokens: readonly string[]
): Record<Mode, Record<string, string>> {
  const css = stripComments(cssText)
  const result = {} as Record<Mode, Record<string, string>>
  for (const mode of ['light', 'dark'] as const) {
    const declared = new Map<string, string>()
    collect(css, ':root', declared)
    if (mode === 'dark') {
      collect(css, '.dark', declared)
    }
    const read = (token: string): string => {
      const raw = declared.get(token)
      return raw === undefined ? '' : (substitute(raw, declared, new Set([token])) ?? '')
    }
    result[mode] = Object.fromEntries(tokens.map((token) => [token, read(token)]))
    // Why: chat paints an omitted link color as --callout-note, as the renderer reads it.
    result[mode]['--text-link'] = read('--text-link') || read('--callout-note')
  }
  return result
}
