import type { DiffComment } from '../../../shared/types'

export type MarkdownCommentBlock = {
  key: string
  startLine: number
  endLine: number
}

export type MarkdownCommentBlockMapping = {
  byBlockKey: Map<string, DiffComment[]>
  unresolved: DiffComment[]
}

export function mapMarkdownCommentsToBlocks(
  comments: DiffComment[],
  blocks: MarkdownCommentBlock[]
): MarkdownCommentBlockMapping {
  const byBlockKey = new Map<string, DiffComment[]>()
  const unresolved: DiffComment[] = []

  for (const comment of comments) {
    const block = blocks.find(
      (candidate) =>
        candidate.startLine <= comment.lineNumber && comment.lineNumber <= candidate.endLine
    )
    if (!block) {
      unresolved.push(comment)
      continue
    }
    const list = byBlockKey.get(block.key) ?? []
    list.push(comment)
    byBlockKey.set(block.key, list)
  }

  for (const list of byBlockKey.values()) {
    list.sort((a, b) => a.lineNumber - b.lineNumber)
  }

  return { byBlockKey, unresolved }
}
