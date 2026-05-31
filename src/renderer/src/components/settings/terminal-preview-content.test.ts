import { describe, expect, it } from 'vitest'
import { PREVIEW_BUFFER } from './terminal-preview-content'

describe('PREVIEW_BUFFER', () => {
  it('contains the canonical content markers', () => {
    // Why: strip ANSI before matching so re-coloring a marker (e.g. splitting
    // "def render" into separate keyword/identifier spans) doesn't break this
    // test — what matters is the visible text the user reads.
    // eslint-disable-next-line no-control-regex
    const stripped = PREVIEW_BUFFER.replace(/\x1b\[[0-9;]*m/g, '')
    expect(stripped).toContain('npm test')
    expect(stripped).toContain('PASS')
    expect(stripped).toContain('ligatures: => != >= <= ===')
    expect(stripped).toContain('git diff')
    expect(stripped).toContain('def total')
  })

  it('ends without a trailing newline so the cursor parks on the prompt', () => {
    expect(PREVIEW_BUFFER.endsWith('\n')).toBe(false)
    expect(PREVIEW_BUFFER).toMatch(/\$ $/)
  })

  it('matches the locked snapshot', () => {
    expect(PREVIEW_BUFFER).toMatchSnapshot()
  })
})
