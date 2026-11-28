import type { ChatApproval } from './native-chat-interactive-prompt'
import { stripAnsiEscapeSequences } from '../../terminal/protocol/escape/ansi-escape-sequences'

const OPTION = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(.+?)\s*$/
const RULE = /^\s*[─━┄┈╌\-=]{8,}\s*$/
const BORDER = /^\s*[│|┃]\s?/
// Claude's own menu footer; nothing else may follow a live menu.
const FOOTER = /^\s*Esc to cancel\b/

/** A numbered choice an agent's terminal shows when it waits without saying why (Claude's auto-mode
 *  confirmation has no permission hook): the question, what led to it, and one option per number. */
export function parseTerminalChoicePrompt(screen: string | null | undefined): ChatApproval | null {
  if (!screen) {
    return null
  }
  // The serialized screen carries color escapes; match the text the user sees.
  const lines = stripAnsiEscapeSequences(screen)
    .split('\n')
    .map((line) => line.trimEnd())
  // Only a menu at the bottom of the live screen, under nothing but the agent's footer: a numbered
  // list printed earlier by a tool or a file must never turn into an answerable card.
  let end = lines.length - 1
  while (end >= 0 && !lines[end]?.trim()) {
    end -= 1
  }
  if (end < 0 || !FOOTER.test(lines[end] ?? '')) {
    return null
  }
  end -= 1
  while (end >= 0 && !lines[end]?.trim()) {
    end -= 1
  }
  if (end < 0 || !OPTION.test(lines[end] ?? '')) {
    return null
  }
  let start = end
  while (start > 0 && OPTION.test(lines[start - 1] ?? '')) {
    start -= 1
  }
  const options = lines.slice(start, end + 1).map((line) => {
    const match = OPTION.exec(line)!
    return { number: match[1]!, label: match[2]! }
  })
  // A real menu numbers its options 1, 2, 3… in order; anything else is prose that looks like one.
  if (options.length < 2 || options.some((option, index) => option.number !== String(index + 1))) {
    return null
  }
  let questionIndex = start - 1
  while (questionIndex >= 0 && !lines[questionIndex]?.trim()) {
    questionIndex -= 1
  }
  const question = lines[questionIndex]?.trim()
  if (!question?.endsWith('?')) {
    return null
  }
  // The block above the question (the command and why it needs a yes) ends at the first blank line.
  const context: string[] = []
  for (let index = questionIndex - 1; index >= 0 && context.length < 24; index -= 1) {
    const line = lines[index] ?? ''
    if (!line.trim() && context.some((entry) => entry.trim())) {
      break
    }
    if (!RULE.test(line)) {
      context.unshift(line.replace(BORDER, ''))
    }
  }
  const detail = context.join('\n').trim()
  return {
    title: question,
    ...(detail ? { detail } : {}),
    options: options.map((option) => ({ label: option.label, send: option.number })),
    screenMenu: JSON.stringify([question, detail, ...options.map((option) => option.label)])
  }
}
