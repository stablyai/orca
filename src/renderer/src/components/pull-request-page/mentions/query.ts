import type { MentionQuery } from '../page-types'

export function findMentionQuery(value: string, caret: number): MentionQuery | null {
  const beforeCaret = value.slice(0, caret)
  const match = /(^|[\s([{,])@([A-Za-z0-9-]*)$/.exec(beforeCaret)
  if (!match) {
    return null
  }
  const query = match[2] ?? ''
  return {
    atIndex: beforeCaret.length - query.length - 1,
    query
  }
}
