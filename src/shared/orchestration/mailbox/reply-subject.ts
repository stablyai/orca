const REPLY_PREFIX = 'Re: '

function replyPrefixesEnd(subject: string, minimum: number): number {
  // Match one marker at a time so long chains never build up a regexp backtracking stack.
  const prefix = /[ \t]*re:(?=[ \t\r\n]|$)/iy
  let count = 0
  let end = 0
  while (prefix.test(subject)) {
    count++
    end = prefix.lastIndex
  }
  if (count < minimum) {
    return 0
  }
  // Consume one separator to retain any leading spaces in the title.
  return subject[end] === ' ' || subject[end] === '\t' ? end + 1 : end
}

export function replySubject(subject: string): string {
  return `${REPLY_PREFIX}${subject.slice(replyPrefixesEnd(subject, 1))}`
}

export function collapseRepeatedReplyPrefixes(subject: string): string {
  const end = replyPrefixesEnd(subject, 2)
  return end === 0 ? subject : `${REPLY_PREFIX}${subject.slice(end)}`
}
