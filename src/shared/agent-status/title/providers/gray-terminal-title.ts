import type { AgentStatus } from '../agent-title-core'

// Gray's OSC 0 title is the directory followed by a middle dot and gray, with a leading circle only during a turn.
const GRAY_TITLE = /^(\u25CF )?[^\s|\u00B7][^\r\n|]* \u00B7 gray$/u

export function grayTitleStatus(title: string): AgentStatus | null {
  const match = GRAY_TITLE.exec(title)
  return match ? (match[1] ? 'working' : 'idle') : null
}
