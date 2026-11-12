import type { PhrasingContent, Root } from 'mdast'
import type { Processor } from 'unified'
import type { VFile } from 'vfile'
import { visit } from 'unist-util-visit'
import { visitParents } from 'unist-util-visit-parents'

type SourceLine = { text: string; offset: number }

function restoreSeparatedBulletItems(
  tree: Root,
  sourceLines: SourceLine[],
  parse: (source: string) => Root
): void {
  let followsBulletList = false
  tree.children = tree.children.flatMap((node) => {
    const lines = node.position
      ? sourceLines.slice(node.position.start.line - 1, node.position.end.line)
      : []
    if (node.type === 'paragraph') {
      followsBulletList = lines.length > 0 && lines.every(({ text }) => /^ *•[ \t]/.test(text))
      return [node]
    }
    if (
      node.type !== 'code' ||
      !followsBulletList ||
      !node.position ||
      lines.length === 0 ||
      !lines.every(({ text }) => /^ {4,}•[ \t]/.test(text) || /^ *$/.test(text))
    ) {
      followsBulletList = false
      return [node]
    }

    // Only a bullet-only continuation can reclaim an indented Markdown code block.
    const parsed = parse(lines.map(({ text }) => text.trimStart()).join('\n'))
    const startLine = node.position.start.line
    visit(parsed, (child) => {
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
    return parsed.children
  })
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
    restoreSeparatedBulletItems(tree, sourceLines, (value) => this.parse(value) as Root)
    visitParents(tree, 'text', (node, ancestors) => {
      const parent = ancestors.at(-1)
      if (ancestors.length !== 2 || parent?.type !== 'paragraph' || !node.position) {
        return
      }
      const lines = node.value.split('\n')
      const { start, end } = node.position
      if (
        start.offset === undefined ||
        end.offset === undefined ||
        source.slice(start.offset, end.offset).split(/\r\n?|\n/).length !== lines.length
      ) {
        return
      }
      const indents = lines.map((line, index) =>
        /^•[ \t]/.test(line)
          ? /^( +)(?=•[ \t])/.exec(sourceLines[start.line - 1 + index]?.text ?? '')?.[1]
          : undefined
      )
      if (!indents.some(Boolean)) {
        return
      }
      const children: PhrasingContent[] = []
      lines.forEach((line, index) => {
        if (index > 0) {
          children.push({ type: 'text', value: '\n' })
        }
        const indent = indents[index]
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
