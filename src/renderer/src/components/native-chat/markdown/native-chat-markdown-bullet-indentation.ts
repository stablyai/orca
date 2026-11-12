import type { PhrasingContent, Root } from 'mdast'
import type { VFile } from 'vfile'
import { visitParents } from 'unist-util-visit-parents'

export function remarkNativeChatBulletIndentation(): (tree: Root, file: VFile) => void {
  return (tree: Root, file: VFile): void => {
    const source = String(file)
    if (!/^ +•[ \t]/m.test(source)) {
      return
    }
    const sourceLines = source.split(/\r\n?|\n/)
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
          ? /^( +)(?=•[ \t])/.exec(sourceLines[start.line - 1 + index] ?? '')?.[1]
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
