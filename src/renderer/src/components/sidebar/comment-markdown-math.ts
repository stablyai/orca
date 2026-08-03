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
const CODE_FENCE = /^\s*(`{3,}|~{3,})/

function normalizeGitHubBacktickMathNode(node: MarkdownAstNode): void {
  if (
    node.type === 'inlineMath' &&
    node.value?.startsWith('`') &&
    node.value.endsWith('`') &&
    node.value.length >= 2
  ) {
    const value = node.value.slice(1, -1)
    node.value = value

    const renderedText = node.data?.hChildren?.[0]
    if (renderedText?.type === 'text') {
      renderedText.value = value
    }
  }

  for (const child of node.children ?? []) {
    normalizeGitHubBacktickMathNode(child)
  }
}

export function normalizeBracketDelimitedMathSource(source: string): string {
  const lines = source.split('\n')
  const normalized: string[] = []
  let index = 0
  let activeFence: CodeFence | undefined

  while (index < lines.length) {
    const line = lines[index]
    const fence = CODE_FENCE.exec(line)?.[1]

    if (activeFence) {
      if (fence && fence[0] === activeFence.marker && fence.length >= activeFence.length) {
        activeFence = undefined
      }
      normalized.push(line)
      index += 1
      continue
    }

    if (fence) {
      activeFence = { marker: fence[0], length: fence.length }
      normalized.push(line)
      index += 1
      continue
    }

    const openingDelimiter = line.trim()
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
    if (!formula || !MATH_SIGNAL.test(formula)) {
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
