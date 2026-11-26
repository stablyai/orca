// Only match prefixes on the subject's first line, including in historical mail envelopes.
const REPLY_PREFIXES = /^(re:[ \t]*)(?:re:[ \t]*)*/i
const REPLY_PREFIX = 'Re: '

export function replySubject(subject: string): string {
  return `${REPLY_PREFIX}${subject.replace(REPLY_PREFIXES, '')}`
}

export function collapseRepeatedReplyPrefixes(subject: string): string {
  const match = REPLY_PREFIXES.exec(subject)
  return match && match[0] !== match[1]
    ? `${REPLY_PREFIX}${subject.slice(match[0].length)}`
    : subject
}
