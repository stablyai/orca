/** With an expected PID, accept only a complete numeric proc-stat record for that process. */
export function parseLinuxProcessState(statLine: string, expectedPid?: number): string | null {
  const commandEnd = statLine.lastIndexOf(')')
  if (commandEnd === -1) {
    return null
  }
  const fields = statLine
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
  const state = fields[0] ?? null
  if (expectedPid !== undefined) {
    // Linux stat has 52 fields; the command may itself contain spaces and closing parentheses.
    if (
      !statLine.startsWith(`${expectedPid} (`) ||
      !/^\s/.test(statLine.slice(commandEnd + 1)) ||
      fields.length < 50 ||
      state === null ||
      !/^[A-Za-z]$/.test(state) ||
      !fields.slice(1).every((field) => /^-?\d+$/.test(field))
    ) {
      return null
    }
  }
  return state
}
