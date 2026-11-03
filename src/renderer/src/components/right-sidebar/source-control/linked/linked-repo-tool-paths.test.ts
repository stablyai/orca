import { describe, expect, it } from 'vitest'
import { extractToolPathUses } from './linked-repo-tool-paths'

describe('extractToolPathUses', () => {
  it('reads the cd directory of a shell command even when the preview is cut off', () => {
    // Status previews stop at 160 chars, so the `>> README.md` part may never arrive.
    const preview = `cd "C:/Users/me/AppData/Local/Temp/demo/demo-lib" && printf 'Test line for l`
    expect(extractToolPathUses('Bash', preview)).toEqual([
      { path: 'C:/Users/me/AppData/Local/Temp/demo/demo-lib', certainWrite: false }
    ])
  })

  it('finds git -C targets and absolute arguments, skipping /dev and variables', () => {
    expect(
      extractToolPathUses('Bash', 'git -C /repos/lib add -A && cp $OUT /repos/app/x 2>/dev/null')
    ).toEqual([
      { path: '/repos/lib', certainWrite: false },
      { path: '/repos/app/x', certainWrite: false }
    ])
  })

  it('treats edit tool paths, including patch headers, as certain writes', () => {
    expect(extractToolPathUses('Edit', '/repos/lib/a.ts')).toEqual([
      { path: '/repos/lib/a.ts', certainWrite: true }
    ])
    const patch = ['*** Begin Patch', '*** Update File: /repos/lib/b.ts', '*** End Patch'].join(
      '\n'
    )
    expect(extractToolPathUses('apply_patch', patch)).toEqual([
      { path: '/repos/lib/b.ts', certainWrite: true }
    ])
  })

  it('ignores read and search tools', () => {
    expect(extractToolPathUses('Read', '/repos/lib/a.ts')).toEqual([])
    expect(extractToolPathUses('Grep', 'TODO')).toEqual([])
  })
})
