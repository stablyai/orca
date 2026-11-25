import { describe, expect, it } from 'vitest'
import { formatBlameColumnLine } from './git-blame-column'
import type { LineBlame } from './git-blame-line-store'

// Monaco inserts a custom line number into the gutter as raw HTML, and the author is untrusted.
describe('formatBlameColumnLine', () => {
  it('escapes markup in the author instead of injecting it into the gutter', () => {
    const blame: LineBlame = {
      kind: 'commit',
      commit: {
        oid: 'a'.repeat(40),
        author: '<img src=x onerror=alert(1)> & "Eve"',
        authorEmail: 'eve@example.com',
        authorTime: Date.UTC(2026, 10, 18, 12),
        summary: 'x'
      }
    }

    const html = formatBlameColumnLine(7, blame, new Map([[blame.commit.oid, 0]]))

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Eve&quot;')
    expect(html).not.toContain('<img')
  })
})
