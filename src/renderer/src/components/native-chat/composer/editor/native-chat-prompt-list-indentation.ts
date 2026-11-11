import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin } from '@tiptap/pm/state'

const LIST_ITEM = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]+/

function positionLeafText(node: ProseMirrorNode): string {
  return node.type.name === 'hardBreak' ? '\n' : '\ufffc'
}

function isInsideCodeFence(lines: readonly string[]): boolean {
  let fence = ''
  for (const line of lines) {
    const content = fence ? line : line.replace(LIST_ITEM, '')
    const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(content)
    if (!match) {
      continue
    }
    if (fence) {
      if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
        fence = ''
      }
    } else if (match[1][0] !== '`' || !match[2].includes('`')) {
      fence = match[1]
    }
  }
  return fence !== ''
}

function previousListItem(lines: readonly string[], indent: number): RegExpExecArray | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].trim() === '') {
      continue
    }
    const match = LIST_ITEM.exec(lines[index])
    if (!match) {
      return null
    }
    if (match[1].length <= indent) {
      return match
    }
  }
  return null
}

export const NativeChatListIndentation = Extension.create({
  name: 'nativeChatListIndentation',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (
              event.key !== 'Tab' ||
              event.defaultPrevented ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.isComposing ||
              event.keyCode === 229 ||
              view.composing ||
              !view.editable
            ) {
              return false
            }
            const { state } = view
            const { selection, doc } = state
            const { $from } = selection
            if (!selection.empty || !$from.parent.isTextblock) {
              return false
            }
            const before = $from.parent.textBetween(0, $from.parentOffset, '\n', positionLeafText)
            const lineStart = $from.pos - before.slice(before.lastIndexOf('\n') + 1).length
            const after = $from.parent.textBetween(
              $from.parentOffset,
              $from.parent.content.size,
              '\n',
              positionLeafText
            )
            const line = before.slice(before.lastIndexOf('\n') + 1) + after.split('\n')[0]
            const item = LIST_ITEM.exec(line)
            if (!item) {
              return false
            }
            const previousLines = doc.textBetween(0, lineStart, '\n', positionLeafText).split('\n')
            if (isInsideCodeFence(previousLines)) {
              return false
            }
            const indent = item[1].length
            const previous = previousListItem(previousLines, event.shiftKey ? indent - 1 : indent)
            const tr = closeHistory(state.tr)
            if (event.shiftKey) {
              if (indent === 0) {
                return false
              }
              const target = previous?.[1].length ?? Math.max(0, indent - 4)
              tr.delete(lineStart + target, lineStart + indent)
            } else {
              if (!previous || previous[1].length !== indent) {
                return false
              }
              tr.insertText(' '.repeat(Math.max(4, previous[0].length - indent)), lineStart)
            }
            view.dispatch(tr.scrollIntoView())
            view.dispatch(closeHistory(view.state.tr))
            return true
          }
        }
      })
    ]
  }
})
