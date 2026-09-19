/** X10 and SGR mouse reports. */
export function isXtermMouseReport(data: string): boolean {
  return (
    (data.startsWith('\x1b[M') && data.length === 6) ||
    (data.startsWith('\x1b[<') && /^\d+;\d+;\d+[Mm]$/.test(data.slice(3)))
  )
}

/** Alternate-buffer wheel reports share the up/down keyboard grammar. */
export function isXtermWheelCursorKey(data: string): boolean {
  return data === '\x1b[A' || data === '\x1b[B' || data === '\x1bOA' || data === '\x1bOB'
}

export function isTerminalInputUnsafeDuringReplay(
  data: string,
  userInput: boolean,
  bufferType: string
): boolean {
  return (
    !userInput ||
    isXtermMouseReport(data) ||
    (bufferType === 'alternate' && isXtermWheelCursorKey(data))
  )
}
