import {
  getTerminalInputByteLength,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'

export function createRemoteRuntimeViewportClaimInput(maxBytes = TERMINAL_INPUT_MAX_BYTES) {
  let text = ''
  let bytes = 0

  return {
    append(value: string): boolean {
      const valueBytes = getTerminalInputByteLength(value)
      if (bytes + valueBytes > maxBytes) {
        return false
      }
      text += value
      bytes += valueBytes
      return true
    },
    clear(): void {
      text = ''
      bytes = 0
    },
    take(): string {
      const value = text
      text = ''
      bytes = 0
      return value
    }
  }
}
