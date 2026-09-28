import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: the watcher owner is the passive half of the closed-last-terminal contract — it must keep
// honouring the tombstone while explicit activation re-seeds. Assert the wiring as source text;
// mounting the full terminal surface costs far more than it returns, and the e2e that covers it
// only runs when an e2e spec changes.
const TERMINAL_PATH = 'src/renderer/src/components/use-terminal-watcher-effects.ts'

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('Terminal auto-create wiring', () => {
  const source = readSource(TERMINAL_PATH)

  it('derives the tombstone from the active worktree row at decision time', () => {
    // Why the live store: a render-captured row goes stale while the activation check runs.
    expect(source).toMatch(
      /Object\.hasOwn\(\s*useAppStore\.getState\(\)\.tabsByWorktree,\s*activeWorktreeId\s*\)/
    )
  })

  it('passes that derivation into shouldAutoCreateInitialTerminal', () => {
    // Why: the regression #14590 fixed is re-introduced by dropping this second argument, and a
    // literal here would pin nothing — it has to be the identifier the effect actually derives.
    // Exactly one call site: a second (flagless) call could otherwise hide behind this one.
    expect(
      source.split('shouldAutoCreateInitialTerminal(').length - 1,
      'expected exactly one shouldAutoCreateInitialTerminal call in the watcher owner'
    ).toBe(1)
    expect(source).toContain(
      'shouldAutoCreateInitialTerminal(renderableTabCount, activeWorktreeHasTerminalState)'
    )
  })
})
