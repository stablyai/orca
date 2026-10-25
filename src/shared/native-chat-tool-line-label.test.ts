import { describe, expect, it } from 'vitest'
import { nativeChatToolLineLabel } from './native-chat-tool-line-label'

describe('nativeChatToolLineLabel', () => {
  it('names a Codex change to several files by its count, and offers no file to open', () => {
    const label = nativeChatToolLineLabel(
      { type: 'tool-call', name: 'Diff', input: { path: '2 files' }, state: 'completed' },
      { type: 'tool-result', output: '@@ -1 +1 @@\n-a\n+b' }
    )
    expect(label).toMatchObject({ verb: 'edited', target: '2 files', filePath: null })
  })

  it('still links a real file whose name reads like a count', () => {
    const label = nativeChatToolLineLabel({
      type: 'tool-call',
      name: 'Read',
      input: { file_path: '2 files' },
      state: 'completed'
    })
    expect(label.filePath).toBe('2 files')
  })

  it('links a read or an edit, never a listed folder', () => {
    const read = nativeChatToolLineLabel({
      type: 'tool-call',
      name: 'Read',
      input: { file_path: 'src/a.ts' },
      state: 'completed'
    })
    const list = nativeChatToolLineLabel({
      type: 'tool-call',
      name: 'list',
      input: { command: 'ls src', path: 'src' },
      state: 'completed'
    })
    expect(read).toMatchObject({ verb: 'read', target: 'a.ts', filePath: 'src/a.ts' })
    expect(list).toMatchObject({ verb: 'listed', filePath: null })
  })
})
