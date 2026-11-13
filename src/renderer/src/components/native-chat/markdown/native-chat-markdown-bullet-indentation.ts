import type { ListItem, Paragraph, PhrasingContent, Root } from 'mdast'
import type { Processor } from 'unified'
import type { VFile } from 'vfile'
import { toMarkdown } from 'mdast-util-to-markdown'
import { decodeString } from 'micromark-util-decode-string'
import { visitParents } from 'unist-util-visit-parents'

type SourceLine = { text: string; offset: number }

function restoreSeparatedBulletItems(
  container: Root | ListItem,
  sourceLines: SourceLine[],
  definitions: string,
  parse: (source: string) => Root
): void {
  let followsBulletList = false
  for (let index = 0; index < container.children.length; index++) {
    const node = container.children[index]
    const lines = node.position
      ? sourceLines.slice(node.position.start.line - 1, node.position.end.line)
      : []
    if (node.type === 'paragraph') {
      followsBulletList =
        (container.type === 'listItem' && index === 0) || /^ *•[ \t]/.test(lines[0]?.text ?? '')
      continue
    }
    if (
      node.type !== 'code' ||
      !followsBulletList ||
      !node.position ||
      lines.length === 0 ||
      !lines.every(({ text }) => /^ {4,}•[ \t]/.test(text) || /^ *$/.test(text))
    ) {
      followsBulletList = false
      continue
    }

    // Only a bullet-only continuation can reclaim an indented Markdown code block.
    const content = lines.map(({ text }) => text.trimStart()).join('\n')
    const paragraphs = parse(`${content}\n\n${definitions}`).children.filter(
      (child): child is Paragraph =>
        child.type === 'paragraph' && !!child.position && child.position.end.line <= lines.length
    )
    if (paragraphs.length === 0) {
      followsBulletList = false
      continue
    }
    const parsed: Root = { type: 'root', children: paragraphs }
    const startLine = node.position.start.line
    visitParents(parsed, (child) => {
      if (!child.position) {
        return
      }
      for (const point of [child.position.start, child.position.end]) {
        const line = lines[point.line - 1]
        const indent = line.text.length - line.text.trimStart().length
        point.column += indent
        point.offset = line.offset + point.column - 1
        point.line += startLine - 1
      }
    })
    container.children.splice(index, 1, ...paragraphs)
    index += paragraphs.length - 1
  }
}

export function remarkNativeChatBulletIndentation(
  this: Processor
): (tree: Root, file: VFile) => void {
  return (tree: Root, file: VFile): void => {
    const source = String(file)
    if (!/^ +•[ \t]/m.test(source)) {
      return
    }
    const sourceLines = [...source.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/g)].map((match) => ({
      text: match[1],
      offset: match.index
    }))
    const definitions: string[] = []
    visitParents(tree, 'definition', (definition) => {
      definitions.push(toMarkdown(definition))
    })
    const definitionSource = definitions.join('\n')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Remark's configured parser returns mdast Root; Processor erases that type.
    const parse = (value: string): Root => this.parse(value) as Root
    visitParents(tree, (node) => {
      if (node.type === 'root' || node.type === 'listItem') {
        restoreSeparatedBulletItems(node, sourceLines, definitionSource, parse)
      }
    })
    visitParents(tree, 'text', (node, ancestors) => {
      const parent = ancestors.at(-1)
      const container = ancestors.at(-2)
      if (
        parent?.type !== 'paragraph' ||
        !node.position ||
        (container?.type !== 'root' && container?.type !== 'listItem')
      ) {
        return
      }
      const containerIndent =
        container.type === 'listItem' ? (container.children[0]?.position?.start.column ?? 1) - 1 : 0
      const lines = node.value.split(/\r\n?|\n/)
      const { start, end } = node.position
      if (start.offset === undefined || end.offset === undefined) {
        return
      }
      const indents = source
        .slice(start.offset, end.offset)
        .split(/\r\n?|\n/)
        .flatMap((line, index) => {
          const sourceIndent = /^( +)(?=•[ \t])/.exec(
            sourceLines[start.line - 1 + index]?.text ?? ''
          )?.[1]
          const indent = sourceIndent?.slice(containerIndent)
          const atBullet = index > 0 || start.column === (sourceIndent?.length ?? 0) + 1
          return decodeString(line)
            .split(/\r\n?|\n/)
            .map((_, decodedIndex) => (atBullet && decodedIndex === 0 ? indent : undefined))
        })
      if (indents.length !== lines.length || !indents.some(Boolean)) {
        return
      }
      const children: PhrasingContent[] = []
      lines.forEach((line, index) => {
        if (index > 0) {
          children.push({ type: 'text', value: '\n' })
        }
        const indent = /^•[ \t]/.test(line) ? indents[index] : undefined
        if (indent) {
          // A span parsed after Markdown survives its hard-break whitespace trimming.
          children.push({
            type: 'html',
            value: `<span class="whitespace-pre-wrap">${indent}</span>`
          })
        }
        children.push({ type: 'text', value: line })
      })
      const index = parent.children.indexOf(node)
      parent.children.splice(index, 1, ...children)
      return index + children.length
    })
  }
}
