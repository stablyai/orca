import type { TerminalCursorContext } from './terminal-composer-draft'

// Why: AiWork's composer glyph is `❱` (U+2771; `!` in shell mode), not the `❯` the shared reader
// requires inside a Claude-style frame. Its rows sit between `─` rules; the cursor stays visible at
// the caret and is hidden while AiWork repaints or a gate box replaces the composer.
const AIWORK_PROMPT_RE = /^\s*[❱!] ?/u
const AIWORK_RULE_RE = /^\s*─{8,}\s*$/u
// Its placeholders (grey, not dim) for chat, shell mode and read-only background sessions, in
// English, Simplified and Traditional Chinese.
const AIWORK_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'Type a message, Enter to send',
  '请输入消息，Enter 发送',
  '請輸入訊息，Enter 發送',
  'Run a shell command',
  '运行 shell 命令',
  '運行 shell 命令',
  'Background session read-only: return to the main session to enter new instructions',
  '后台会话只读：请回到主会话输入新指令',
  '後台會話只讀：請回到主會話輸入新指令'
])
const MAX_DRAFT_ROWS = 12

/** Whether AiWork's composer shows a typed draft, so mail must wait. Callers check that AiWork is
 *  the pane's agent. */
export function aiworkComposerHoldsDraft(context: TerminalCursorContext): boolean {
  if (context.cursorHidden) {
    return false
  }
  const cursorIndex = context.rows.length - 1
  const rowText = (index: number): string =>
    index === cursorIndex
      ? `${context.beforeCursor}${context.afterCursor}`
      : (context.typedRows[index] ?? '')
  for (let index = cursorIndex; index >= Math.max(0, cursorIndex - MAX_DRAFT_ROWS); index -= 1) {
    const row = rowText(index)
    if (AIWORK_RULE_RE.test(row)) {
      return false
    }
    if (AIWORK_PROMPT_RE.test(row)) {
      if (!AIWORK_RULE_RE.test(context.rows[index - 1] ?? '')) {
        return false
      }
      const rows = [row.replace(AIWORK_PROMPT_RE, '')]
      for (let next = index + 1; next <= cursorIndex; next += 1) {
        rows.push(rowText(next))
      }
      const text = rows.join(' ').replace(/\s+/g, ' ').trim()
      return text.length > 0 && !AIWORK_PLACEHOLDERS.has(text)
    }
  }
  return false
}
