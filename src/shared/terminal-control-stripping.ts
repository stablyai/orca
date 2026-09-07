const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`,
  'g'
)
const INCOMPLETE_ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*|\\][^${BEL}${ESC}]*|\\S?)?$`,
  'g'
)
const CONTROL_DENSITY_BLOCK_CODE_UNITS = 64
const CONTROL_DENSITY_FALLBACK_COUNT = 32

function isStrippedTerminalControl(code: number): boolean {
  return (code <= 0x1f && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)
}

export function stripTerminalControl(data: string): string {
  if (!terminalControlMayAffectText(data)) {
    return data
  }
  const withoutAnsi = data.replace(ANSI_ESCAPE_RE, '').replace(INCOMPLETE_ANSI_ESCAPE_RE, '')
  // Four calls per PTY chunk favor copying sparse intact runs over per-character concatenation.
  let output = ''
  let runStart = 0
  let strippedInBlock = 0
  let blockEnd = CONTROL_DENSITY_BLOCK_CODE_UNITS
  for (let index = 0; index < withoutAnsi.length; index += 1) {
    if (index === blockEnd) {
      strippedInBlock = 0
      blockEnd += CONTROL_DENSITY_BLOCK_CODE_UNITS
    }
    if (isStrippedTerminalControl(withoutAnsi.charCodeAt(index))) {
      if (index > runStart) {
        output += withoutAnsi.slice(runStart, index)
      }
      runStart = index + 1
      strippedInBlock += 1
      if (strippedInBlock === CONTROL_DENSITY_FALLBACK_COUNT) {
        let tailOutput = ''
        for (let tailIndex = runStart; tailIndex < withoutAnsi.length; tailIndex += 1) {
          const tailCode = withoutAnsi.charCodeAt(tailIndex)
          // Inlined isStrippedTerminalControl: this tail runs per code unit on the shape that
          // already lost to the call overhead. Keep the two copies in sync.
          if (
            (tailCode <= 0x1f && tailCode !== 0x0a && tailCode !== 0x0d) ||
            (tailCode >= 0x7f && tailCode <= 0x9f)
          ) {
            continue
          }
          tailOutput += withoutAnsi[tailIndex]
        }
        return output + tailOutput
      }
    }
  }
  return runStart === 0 ? withoutAnsi : output + withoutAnsi.slice(runStart)
}

function terminalControlMayAffectText(data: string): boolean {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index)
    if (
      code === 0x0d ||
      code === 0x1b ||
      (code <= 0x1f && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true
    }
  }
  return false
}
