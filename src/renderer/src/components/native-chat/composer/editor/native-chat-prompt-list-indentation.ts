import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin } from '@tiptap/pm/state'

const LIST_ITEM = /^([ \t]*)(?:[-*•]|\d{1,9}[.)])[ \t]+/
// Code stays literal even inside a Markdown '+' list that these shortcuts do not edit.
const FENCE_LIST_ITEM = /^[ \t]*(?:[-+*•]|\d{1,9}[.)])[ \t]+/

function positionLeafText(node: ProseMirrorNode): string {
  // Chips occupy one document position; their serialized tokens would shift the calculated line start.
  return node.type.name === 'hardBreak' ? '\n' : '\ufffc'
}

function matchCodeFence(line: string): RegExpExecArray | null {
  const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
  return match && (match[1][0] !== '`' || !match[2].includes('`')) ? match : null
}

function isInsideCodeFence(lines: readonly string[]): boolean {
  let fence = ''
  for (const line of lines) {
    const content = fence ? line : line.replace(FENCE_LIST_ITEM, '')
    const match = matchCodeFence(content)
    if (!match) {
      continue
    }
    if (fence) {
      if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
        fence = ''
      }
    } else {
      fence = match[1]
    }
  }
  return fence !== ''
}

function previousListItem(lines: readonly string[], indent: number): RegExpExecArray | null {
  let continuationIndent = Infinity
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].trim() === '') {
      continue
    }
    if (matchCodeFence(lines[index])) {
      return null
    }
    const match = LIST_ITEM.exec(lines[index])
    if (!match) {
      const leading = /^ +/.exec(lines[index])
      if (leading) {
        continuationIndent = Math.min(continuationIndent, leading[0].length)
        continue
      }
      return null
    }
    if (match[0].includes('\t') || match[0].length > continuationIndent) {
      return null
    }
    if (match[1].length <= indent) {
      return match
    }
    continuationIndent = Infinity
  }
  return null
}

export const NativeChatListIndentation = Extension.create({
  name: 'nativeChatListIndentation',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput(view, from, to, text) {
            if (text !== ' ' || from !== to || view.composing || !view.editable) {
              return false
            }
            const $from = view.state.doc.resolve(from)
            const before = $from.parent.textBetween(0, $from.parentOffset, '\n', positionLeafText)
            const prefix = before.slice(before.lastIndexOf('\n') + 1)
            if (!/^ *[-*]$/.test(prefix)) {
              return false
            }
            const previousLines = view.state.doc
              .textBetween(0, from - prefix.length, '\n', positionLeafText)
              .split('\n')
            if (isInsideCodeFence(previousLines)) {
              return false
            }
            view.dispatch(view.state.tr.insertText('• ', from - 1, to))
            return true
          },
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
            if (!item || item[0].includes('\t')) {
              return false
            }
            const previousLines = doc.textBetween(0, lineStart, '\n', positionLeafText).split('\n')
            if (isInsideCodeFence(previousLines)) {
              return false
            }
            const indent = item[1].length
            const previous = previousListItem(previousLines, event.shiftKey ? indent - 1 : indent)
            // Keep indentation separate from text typed immediately before or after it in undo history.
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
            if (/[-*]/.test(line[indent])) {
              const marker = tr.mapping.map(lineStart + indent)
              tr.insertText('•', marker, marker + 1)
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
