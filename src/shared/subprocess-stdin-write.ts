import type { Writable } from 'node:stream'

export function endSubprocessStdin(stdin: Writable | null | undefined, input: string): void {
  if (!stdin) {
    return
  }
  // Why: early exit or timeout can close a large write; the child callback owns the command result.
  stdin.once('error', () => {})
  stdin.end(input)
}
