import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('GitHubMarkdownComposer editable toggle', () => {
  it('never emits an update event from setEditable', () => {
    // Why: TipTap's setEditable defaults to emitUpdate=true, which fires onUpdate with the
    // editor's stale content and clobbers a value applied in the same commit as the disabled
    // toggle (AI-generated issue fields arriving while the fields unlock).
    const source = readFileSync(join(__dirname, 'GitHubMarkdownComposer.tsx'), 'utf8')
    const calls = source.match(/setEditable\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toMatch(/setEditable\(.+, false\)/)
    }
  })
})
