import {
  findDescribeBodyBrace,
  skipQuotedString,
  skipTemplateLiteral,
  skipWhitespaceAndComments,
  slugTitle
} from './test-case-outline-tokens'

export type TestOutlineKind = 'describe' | 'it'

export type TestOutlineModifier = 'each' | 'skip' | 'only' | 'todo' | 'concurrent'

export type TestOutlineNode = {
  children: TestOutlineNode[]
  id: string
  kind: TestOutlineKind
  line: number
  modifier?: TestOutlineModifier
  title: string
}

const MAX_TEST_OUTLINE_NODES = 2000

// Why: stateful scanner skips literals/comments so multiline calls, tagged .each, and nested suites parse statically without execution.
/**
 * Parses test specification source code into a hierarchical outline tree.
 */
export function parseTestCaseOutline(content: string): TestOutlineNode[] {
  const normalized = content.replace(/\r\n/g, '\n')
  const len = normalized.length
  const roots: TestOutlineNode[] = []
  const stack: { scopeDepth: number; node: TestOutlineNode }[] = []
  let depth = 0
  let line = 1
  let i = 0
  let nodeCount = 0
  const seenIds = new Set<string>()
  const incLine = (): void => {
    line++
  }

  function addNode(
    kind: TestOutlineKind,
    modifier: TestOutlineModifier | undefined,
    title: string,
    nodeLine: number
  ): TestOutlineNode | null {
    if (nodeCount >= MAX_TEST_OUTLINE_NODES) {
      return null
    }
    const trimmed = title.trim()
    if (!trimmed) {
      return null
    }

    const slug = slugTitle(trimmed) || 'test'
    let id = `${nodeLine}-${slug}`
    let suffix = 2
    while (seenIds.has(id)) {
      id = `${nodeLine}-${slug}-${suffix}`
      suffix++
    }
    seenIds.add(id)

    const node: TestOutlineNode = {
      children: [],
      id,
      kind,
      line: nodeLine,
      modifier,
      title: trimmed
    }

    const parent = stack.length > 0 ? (stack.at(-1)?.node ?? null) : null
    if (parent === null) {
      roots.push(node)
    } else {
      parent.children.push(node)
    }
    nodeCount++
    return node
  }

  while (i < len) {
    const ch = normalized[i]

    if (ch === '\n') {
      line++
      i++
      continue
    }
    if (ch === '/' && (normalized[i + 1] === '/' || normalized[i + 1] === '*')) {
      i = skipWhitespaceAndComments(normalized, i, len, incLine)
      continue
    }
    if (ch === "'" || ch === '"') {
      i = skipQuotedString(normalized, i, len, incLine)
      continue
    }
    if (ch === '`') {
      i = skipTemplateLiteral(normalized, i, len, incLine)
      continue
    }
    if (ch === '{') {
      depth++
      i++
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      while (stack.length > 0 && (stack.at(-1)?.scopeDepth ?? 0) > depth) {
        stack.pop()
      }
      i++
      continue
    }

    const prev = i > 0 ? normalized[i - 1] : ' '
    if (!/[\w$.]/.test(prev)) {
      let callKind: TestOutlineKind | null = null
      let idLen = 0

      if (normalized.startsWith('describe', i) && !/[\w$]/.test(normalized[i + 8] || '')) {
        callKind = 'describe'
        idLen = 8
      } else if (normalized.startsWith('it', i) && !/[\w$]/.test(normalized[i + 2] || '')) {
        callKind = 'it'
        idLen = 2
      } else if (normalized.startsWith('test', i) && !/[\w$]/.test(normalized[i + 4] || '')) {
        callKind = 'it'
        idLen = 4
      }

      if (callKind) {
        const startLine = line
        let cur = i + idLen
        let modifier: TestOutlineModifier | undefined = undefined
        let isEach = false

        while (cur < len && normalized[cur] === '.') {
          cur++
          const modMatch = /^(each|skip|only|todo|concurrent)\b/.exec(normalized.slice(cur))
          if (modMatch) {
            const mod = modMatch[1] as TestOutlineModifier
            if (mod === 'each') {
              isEach = true
            }
            if (
              !modifier ||
              modifier === 'each' ||
              (modifier === 'concurrent' && (mod === 'only' || mod === 'skip' || mod === 'todo'))
            ) {
              modifier = mod
            }
            cur += mod.length
          } else {
            break
          }
        }

        cur = skipWhitespaceAndComments(normalized, cur, len, incLine)

        if (isEach) {
          if (normalized[cur] === '`') {
            cur = skipTemplateLiteral(normalized, cur, len, incLine)
          } else if (normalized[cur] === '(') {
            cur++
            let parenDepth = 1
            while (cur < len && parenDepth > 0) {
              const pCh = normalized[cur]
              if (pCh === '(') {
                parenDepth++
              } else if (pCh === ')') {
                parenDepth--
              } else if (pCh === '\n') {
                line++
              } else if (pCh === "'" || pCh === '"') {
                cur = skipQuotedString(normalized, cur, len, incLine)
                continue
              } else if (pCh === '`') {
                cur = skipTemplateLiteral(normalized, cur, len, incLine)
                continue
              }
              cur++
            }
          }
          cur = skipWhitespaceAndComments(normalized, cur, len, incLine)
        }

        if (cur < len && normalized[cur] === '(') {
          cur++
          cur = skipWhitespaceAndComments(normalized, cur, len, incLine)

          if (
            cur < len &&
            (normalized[cur] === '"' || normalized[cur] === "'" || normalized[cur] === '`')
          ) {
            const quote = normalized[cur]
            cur++
            let title = ''
            while (cur < len && normalized[cur] !== quote) {
              if (normalized[cur] === '\\') {
                cur++
                if (cur < len) {
                  title += normalized[cur]
                }
              } else {
                if (normalized[cur] === '\n') {
                  line++
                }
                title += normalized[cur]
              }
              cur++
            }
            if (cur < len) {
              cur++
            }

            const node = addNode(callKind, modifier, title, startLine)

            if (callKind === 'describe' && node) {
              const body = findDescribeBodyBrace(normalized, cur, len, incLine)
              cur = body.next
              if (body.foundBody) {
                depth++
                stack.push({ scopeDepth: depth, node })
              }
            }

            i = cur
            continue
          }
        }

        // Why: failed lookahead advanced line through whitespace/comments; restore so main loop doesn't double count.
        line = startLine
      }
    }

    i++
  }

  return roots
}
