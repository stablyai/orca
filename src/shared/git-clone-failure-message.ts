export function getGitCloneFailureMessage(
  stderr: string,
  options: { clonePath?: string | null } = {}
): string {
  let fallbackLine: string | null = null

  for (const rawLine of iterateLinesFromEnd(stderr)) {
    const line = stripAnsi(rawLine).trim()
    if (!line) {
      continue
    }
    fallbackLine ??= line
    const fatalIndex = line.indexOf('fatal:')
    if (fatalIndex !== -1) {
      return formatGitCloneFailureLine(line.slice(fatalIndex), options)
    }
    const errorIndex = line.indexOf('error:')
    if (errorIndex !== -1) {
      return formatGitCloneFailureLine(line.slice(errorIndex), options)
    }
  }

  return formatGitCloneFailureLine(fallbackLine ?? 'unknown error', options)
}

function* iterateLinesFromEnd(value: string): Generator<string> {
  let lineEnd = value.length
  let index = value.length - 1

  while (index >= 0) {
    const code = value.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      index--
      continue
    }

    const delimiterStart =
      code === 10 && index > 0 && value.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield value.slice(index + 1, lineEnd)
    lineEnd = delimiterStart
    index = delimiterStart - 1
  }

  yield value.slice(0, lineEnd)
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
}

function formatGitCloneFailureLine(line: string, options: { clonePath?: string | null }): string {
  const destinationMatch = line.match(
    /^fatal:\s+destination path '([^']+)' already exists and is not an empty directory\.$/
  )
  if (destinationMatch || /repository exists/i.test(line)) {
    const destination = options.clonePath?.trim() || destinationMatch?.[1] || null
    const target = destination ? `: ${destination}` : ''
    return `Destination already exists and is not empty${target}. Choose a different parent folder, delete the existing folder, or add the existing repository instead.`
  }
  return line
}
