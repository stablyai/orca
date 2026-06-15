export function getGitCloneFailureMessage(
  stderr: string,
  options: { clonePath?: string | null } = {}
): string {
  const lines = stderr
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    const fatalIndex = line.indexOf('fatal:')
    if (fatalIndex !== -1) {
      return formatGitCloneFailureLine(line.slice(fatalIndex), options)
    }
    const errorIndex = line.indexOf('error:')
    if (errorIndex !== -1) {
      return formatGitCloneFailureLine(line.slice(errorIndex), options)
    }
  }

  return formatGitCloneFailureLine(lines.at(-1) ?? 'unknown error', options)
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
