// A colon inside a word belongs to the title. Consume one separator to retain the title's spacing.
const REPLY_PREFIXES = /^[ \t]*re:(?=[ \t\r\n]|$)([ \t]+re:(?=[ \t\r\n]|$))*[ \t]?/i
const REPLY_PREFIX = 'Re: '

export function replySubject(subject: string): string {
  return `${REPLY_PREFIX}${subject.replace(REPLY_PREFIXES, '')}`
}

export function collapseRepeatedReplyPrefixes(subject: string): string {
  const match = REPLY_PREFIXES.exec(subject)
  return match?.[1] ? `${REPLY_PREFIX}${subject.slice(match[0].length)}` : subject
}
