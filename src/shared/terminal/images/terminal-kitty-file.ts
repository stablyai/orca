// Base64 fits within the existing 4 MiB paired-runtime reply budget.
export const TERMINAL_KITTY_FILE_MAX_BYTES = 2 * 1024 * 1024

export type TerminalKittyFileRequest = {
  path: string
  offset?: number
  length?: number
  expectedIncarnationId?: string
}

export type TerminalKittyFileResult = { base64: string }
