// Why: token scanning skips strings, comments, and templates so outlines extract without AST parsing.
/**
 * Skips a single- or double-quoted string literal.
 */
export function skipQuotedString(
  code: string,
  start: number,
  len: number,
  onNewline: () => void
): number {
  const quote = code[start]
  let idx = start + 1
  while (idx < len && code[idx] !== quote) {
    if (code[idx] === '\\') {
      idx += 2
      continue
    }
    if (code[idx] === '\n') {
      onNewline()
    }
    idx++
  }
  return idx < len ? idx + 1 : idx
}

/**
 * Skips a template literal including expressions.
 */
export function skipTemplateLiteral(
  code: string,
  start: number,
  len: number,
  onNewline: () => void
): number {
  let idx = start + 1
  while (idx < len && code[idx] !== '`') {
    if (code[idx] === '\\') {
      idx += 2
      continue
    }
    if (code[idx] === '$' && code[idx + 1] === '{') {
      idx += 2
      let interpDepth = 1
      while (idx < len && interpDepth > 0) {
        if (code[idx] === '{') {
          interpDepth++
        } else if (code[idx] === '}') {
          interpDepth--
        } else if (code[idx] === '\n') {
          onNewline()
        }
        idx++
      }
      continue
    }
    if (code[idx] === '\n') {
      onNewline()
    }
    idx++
  }
  return idx < len ? idx + 1 : idx
}

/**
 * Skips whitespace, line comments, and block comments.
 */
export function skipWhitespaceAndComments(
  code: string,
  start: number,
  len: number,
  onNewline: () => void
): number {
  let idx = start
  while (idx < len) {
    const ch = code[idx]
    if (ch === '\n') {
      onNewline()
      idx++
    } else if (/\s/.test(ch)) {
      idx++
    } else if (ch === '/' && code[idx + 1] === '/') {
      idx += 2
      while (idx < len && code[idx] !== '\n') {
        idx++
      }
    } else if (ch === '/' && code[idx + 1] === '*') {
      idx += 2
      while (idx < len && !(code[idx] === '*' && code[idx + 1] === '/')) {
        if (code[idx] === '\n') {
          onNewline()
        }
        idx++
      }
      if (idx < len) {
        idx += 2
      }
    } else {
      break
    }
  }
  return idx
}

/**
 * Converts a test title into a URL/DOM friendly slug.
 */
export function slugTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Scans past describe callback parameters to locate the opening brace of the suite body.
 */
export function findDescribeBodyBrace(
  code: string,
  start: number,
  len: number,
  onNewline: () => void
): { next: number; foundBody: boolean } {
  let cur = start
  let inParen = 0
  while (cur < len) {
    const ch = code[cur]
    if (ch === '\n') {
      onNewline()
      cur++
    } else if (ch === '/' && (code[cur + 1] === '/' || code[cur + 1] === '*')) {
      cur = skipWhitespaceAndComments(code, cur, len, onNewline)
    } else if (ch === "'" || ch === '"') {
      cur = skipQuotedString(code, cur, len, onNewline)
    } else if (ch === '`') {
      cur = skipTemplateLiteral(code, cur, len, onNewline)
    } else if (ch === '(') {
      inParen++
      cur++
    } else if (ch === ')') {
      if (inParen === 0) {
        break
      }
      inParen--
      cur++
    } else if (ch === '{') {
      if (inParen > 0) {
        cur++
        let b = 1
        while (cur < len && b > 0) {
          if (code[cur] === '\n') {
            onNewline()
          } else if (code[cur] === '{') {
            b++
          } else if (code[cur] === '}') {
            b--
          }
          cur++
        }
        continue
      }

      let b = 1
      let temp = cur + 1
      const noop = (): void => {}
      while (temp < len && b > 0) {
        const t = code[temp]
        if (t === '/' && (code[temp + 1] === '/' || code[temp + 1] === '*')) {
          temp = skipWhitespaceAndComments(code, temp, len, noop)
          continue
        }
        if (t === "'" || t === '"') {
          temp = skipQuotedString(code, temp, len, noop)
          continue
        }
        if (t === '`') {
          temp = skipTemplateLiteral(code, temp, len, noop)
          continue
        }
        if (t === '{') {
          b++
        } else if (t === '}') {
          b--
        }
        temp++
      }
      let afterBrace = temp
      while (afterBrace < len && /\s/.test(code[afterBrace])) {
        afterBrace++
      }
      if (code[afterBrace] === ',') {
        while (cur < temp) {
          if (code[cur] === '\n') {
            onNewline()
          }
          cur++
        }
        continue
      }

      return { next: cur + 1, foundBody: true }
    } else {
      cur++
    }
  }
  return { next: cur, foundBody: false }
}
