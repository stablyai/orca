import { renderNestedMarkdownContent } from '@tiptap/core'
import { TaskItem } from '@tiptap/extension-list'

export const RichMarkdownTaskItem = TaskItem.extend({
  renderMarkdown(node, helpers) {
    const mainContent = node.content?.[0]
    const prefix = `- [${node.attrs?.checked ? 'x' : ' '}] `
    return renderNestedMarkdownContent(
      node,
      {
        ...helpers,
        renderChildren(children) {
          const markdown = helpers.renderChildren(children)
          return Array.isArray(children) && children.length === 1 && children[0] === mainContent
            ? markdown.replaceAll('\n', `\n${helpers.indent('')}`)
            : markdown
        }
      },
      prefix
    )
  }
})
