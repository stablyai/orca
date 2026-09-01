import { expect } from 'vitest'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

// A startup plan's launch command carries the real script encoded for the target shell — octal
// escapes fed to `printf %b` on POSIX, UTF-16 base64 for PowerShell. Assertions want the script,
// so these decode it back.

export function unwrapPosixShellScript(command: string | undefined): string {
  const tokenized = tokenizeStartupCommand(command ?? '', 'posix')
  expect(tokenized.ok).toBe(true)
  const wrapper = tokenized.ok ? (tokenized.tokens[2] ?? '') : ''
  const encoded = wrapper.match(/printf %b "([\\0-7]+)"/)?.[1]
  if (!encoded) {
    return wrapper
  }
  const bytes = [...encoded.matchAll(/\\0([0-7]{3})/g)].map((match) => Number.parseInt(match[1], 8))
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function unwrapPowerShellScript(command: string | undefined): string {
  const encoded = command?.match(/-EncodedCommand\s+(\S+)/)?.[1]
  expect(encoded).toBeDefined()
  return Buffer.from(encoded!, 'base64').toString('utf16le')
}
