type MarkdownAstNode = {
  type: string
  value?: string
  data?: {
    hChildren?: MarkdownAstNode[]
  }
  children?: MarkdownAstNode[]
}

type CodeFence = {
  marker: string
  length: number
}

const MATH_SIGNAL = /\\[A-Za-z]+|[=^_]/
const CODE_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const CURRENCY_AMOUNT = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?'
const CURRENCY_MATH_VALUE = new RegExp(
  `^(${CURRENCY_AMOUNT})\\s*(?:to|and|or|through|until|[-–—,])\\s*$`,
  'i'
)
const CURRENCY_TEXT_START = new RegExp(`^${CURRENCY_AMOUNT}(?=\\D|$)`)

function isPairedCurrencyMath(
  node: MarkdownAstNode,
  nextNode: MarkdownAstNode | undefined
): boolean {
  if (node.type !== 'inlineMath' || !node.value || nextNode?.type !== 'text' || !nextNode.value) {
    return false
  }

  const match = CURRENCY_MATH_VALUE.exec(node.value)
  return match !== null && CURRENCY_TEXT_START.test(nextNode.value)
}

function normalizeGitHubBacktickMathNode(node: MarkdownAstNode): void {
  const children = node.children ?? []
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (isPairedCurrencyMath(child, children[index + 1])) {
      child.type = 'text'
      child.value = `$${child.value}$`
      child.data = undefined
    } else if (
      child.type === 'inlineMath' &&
      child.value?.startsWith('`') &&
      child.value.endsWith('`') &&
      child.value.length >= 2
    ) {
      const value = child.value.slice(1, -1)
      child.value = value

      const renderedText = child.data?.hChildren?.[0]
      if (renderedText?.type === 'text') {
        renderedText.value = value
      }
    }

    normalizeGitHubBacktickMathNode(child)
  }
}

function closesCodeFence(fenceMatch: RegExpExecArray | null, activeFence: CodeFence): boolean {
  return (
    fenceMatch !== null &&
    fenceMatch[2][0] === activeFence.marker &&
    fenceMatch[2].length >= activeFence.length &&
    fenceMatch[3].trim().length === 0
  )
}

export function normalizeBracketDelimitedMathSource(source: string): string {
  const lines = source.split('\n')
  const normalized: string[] = []
  let index = 0
  let activeFence: CodeFence | undefined

  while (index < lines.length) {
    const line = lines[index]
    const fenceMatch = CODE_FENCE.exec(line)

    if (activeFence) {
      if (closesCodeFence(fenceMatch, activeFence)) {
        activeFence = undefined
      }
      normalized.push(line)
      index += 1
      continue
    }

    if (fenceMatch) {
      normalized.push(line)
      activeFence = { marker: fenceMatch[2][0], length: fenceMatch[2].length }
      index += 1
      continue
    }

    if (/^(?: {4}|\t)/.test(line)) {
      normalized.push(line)
      index += 1
      continue
    }

    const openingDelimiter = line.trim()
    const sameLineTexMatch = /^\\\[(.+)\\\]$/.exec(openingDelimiter)
    if (sameLineTexMatch) {
      normalized.push('```math', sameLineTexMatch[1].trim(), '```')
      index += 1
      continue
    }

    if (openingDelimiter !== '[' && openingDelimiter !== '\\[') {
      normalized.push(line)
      index += 1
      continue
    }

    const closingDelimiter = openingDelimiter === '\\[' ? '\\]' : ']'
    let closingIndex = index + 1
    while (closingIndex < lines.length && lines[closingIndex].trim() !== closingDelimiter) {
      closingIndex += 1
    }

    if (closingIndex === lines.length) {
      normalized.push(line)
      index += 1
      continue
    }

    const formula = lines.slice(index + 1, closingIndex).join('\n')
    if (!formula || (openingDelimiter === '[' && !MATH_SIGNAL.test(formula))) {
      normalized.push(line)
      index += 1
      continue
    }

    normalized.push('```math', formula, '```')
    index = closingIndex + 1
  }

  return normalized.join('\n')
}

export function remarkGitHubBacktickMath(): (tree: MarkdownAstNode) => void {
  return normalizeGitHubBacktickMathNode
}
