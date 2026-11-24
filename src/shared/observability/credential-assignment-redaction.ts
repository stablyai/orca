const CREDENTIAL_ASSIGNMENT = /(?<![\w-])(?:\\?["'])?([\w-]+)(?:\\?["'])?\s*[:=]\s*/g
const CREDENTIAL_NAME =
  /(?:apikey|token|secret|password|bearer|authorization|privkey|privatekey|secretkey)$/i
const BARE_CREDENTIAL_NAME = /^(?:api[-_]?key|token|secret|password|bearer|authorization)$/i
const AUTH_SCHEME = /(?:Basic|Bearer|Token)[^\S\r\n\u2028\u2029]+/iy
const LINE_END = /[\r\n\u2028\u2029]/

function credentialValueSpan(
  input: string,
  start: number
): { end: number; quoteSize: number; closed: boolean } {
  const escaped = input[start] === '\\' && /["']/.test(input[start + 1] ?? '')
  const quote = input[start + (escaped ? 1 : 0)]
  if (quote !== '"' && quote !== "'") {
    AUTH_SCHEME.lastIndex = start
    let end = AUTH_SCHEME.test(input) ? AUTH_SCHEME.lastIndex : start
    while (end < input.length && !/\s/.test(input[end]!)) {
      end++
    }
    return { end, quoteSize: 0, closed: false }
  }
  const quoteSize = escaped ? 2 : 1
  let end = start + quoteSize
  while (end < input.length && !LINE_END.test(input[end]!)) {
    let slashes = 0
    while (input[end] === '\\') {
      slashes++
      end++
    }
    if (input[end] === quote && (escaped ? slashes % 4 === 1 : slashes % 2 === 0)) {
      return { end: end + 1, quoteSize, closed: true }
    }
    if (end < input.length && !LINE_END.test(input[end]!)) {
      end++
    }
  }
  return { end, quoteSize, closed: false }
}

export function redactCredentialAssignments(input: string): string {
  const parts: string[] = []
  let copiedThrough = 0
  CREDENTIAL_ASSIGNMENT.lastIndex = 0
  for (
    let match = CREDENTIAL_ASSIGNMENT.exec(input);
    match;
    match = CREDENTIAL_ASSIGNMENT.exec(input)
  ) {
    if (!CREDENTIAL_NAME.test(match[1]!.replace(/[-_]/g, ''))) {
      continue
    }
    const start = CREDENTIAL_ASSIGNMENT.lastIndex
    const span = credentialValueSpan(input, start)
    const quote = input.slice(start, start + span.quoteSize)
    // Compound labels retain quotes and .env ownership across repeated sink passes.
    const preserveLabel = !BARE_CREDENTIAL_NAME.test(match[1]!)
    parts.push(
      input.slice(copiedThrough, match.index),
      preserveLabel ? input.slice(match.index, start) + quote : '',
      '[redacted:labeled-kv]',
      preserveLabel && span.closed ? quote : ''
    )
    copiedThrough = span.end
    CREDENTIAL_ASSIGNMENT.lastIndex = span.end
  }
  if (parts.length === 0) {
    return input
  }
  parts.push(input.slice(copiedThrough))
  return parts.join('')
}
