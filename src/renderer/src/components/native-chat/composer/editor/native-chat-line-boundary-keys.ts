import { Extension, type Editor, type KeyboardShortcutCommand } from '@tiptap/core'
import type { ResolvedPos } from '@tiptap/pm/model'
import { isMacUserAgent } from '@/app-shell/platform/user-agent-platform'

function lineBoundary($pos: ResolvedPos, side: 'start' | 'end'): number {
  const blockStart = $pos.start()
  let boundary = side === 'start' ? blockStart : $pos.end()
  $pos.parent.forEach((child, offset) => {
    if (child.type.name !== 'hardBreak') {
      return
    }
    const at = blockStart + offset
    if (side === 'start' && at < $pos.pos) {
      boundary = at + child.nodeSize
    } else if (side === 'end' && at >= $pos.pos && at < boundary) {
      boundary = at
    }
  })
  return boundary
}

function selectLineSide(editor: Editor, side: 'start' | 'end'): boolean {
  const { selection } = editor.state
  const $pos = side === 'start' ? selection.$from : selection.$to
  if (!$pos.parent.isTextblock) {
    return false
  }
  return editor.chain().setTextSelection(lineBoundary($pos, side)).scrollIntoView().run()
}

// Why: Shift+Enter adds a hard break inside the paragraph, and Tiptap's macOS Ctrl-a/Ctrl-e jump to the whole paragraph's edge.
export const NativeChatLineBoundaryKeys = Extension.create({
  name: 'nativeChatLineBoundaryKeys',
  priority: 1000,
  addKeyboardShortcuts(): Record<string, KeyboardShortcutCommand> {
    // Elsewhere Ctrl-a is select all.
    if (!isMacUserAgent()) {
      return {}
    }
    return {
      'Ctrl-a': ({ editor }) => selectLineSide(editor, 'start'),
      'Ctrl-e': ({ editor }) => selectLineSide(editor, 'end')
    }
  }
})
