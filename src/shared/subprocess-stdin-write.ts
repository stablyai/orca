import type { Writable } from 'node:stream'

export function endSubprocessStdin(stdin: Writable | null | undefined, input: string): void {
  if (!stdin) {
    return
  }
  // Early exit/timeout may break a large write; the child callback owns the command result.
  stdin.once('error', () => {})
  stdin.end(input)
}
