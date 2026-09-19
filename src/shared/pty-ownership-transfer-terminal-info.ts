export type PtyOwnershipTransferTerminalInfo = Readonly<{
  pid: number
  cols: number
  rows: number
  initialCwd: string
  terminalHandle?: string
}>

export function parsePtyOwnershipTransferTerminalInfo(
  value: unknown
): PtyOwnershipTransferTerminalInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_terminal_info_invalid')
  }
  const record = value as Record<string, unknown>
  if (
    ![record.pid, record.cols, record.rows].every(
      (entry) => Number.isSafeInteger(entry) && Number(entry) > 0
    ) ||
    typeof record.initialCwd !== 'string' ||
    !record.initialCwd ||
    record.initialCwd.length > 32768 ||
    record.initialCwd.includes('\0') ||
    (record.terminalHandle !== undefined &&
      (typeof record.terminalHandle !== 'string' ||
        !/^term_[A-Za-z0-9_-]{1,256}$/.test(record.terminalHandle)))
  ) {
    throw new Error('pty_ownership_transfer_terminal_info_invalid')
  }
  return Object.freeze({
    pid: Number(record.pid),
    cols: Number(record.cols),
    rows: Number(record.rows),
    initialCwd: record.initialCwd,
    ...(record.terminalHandle !== undefined
      ? { terminalHandle: record.terminalHandle as string }
      : {})
  })
}
