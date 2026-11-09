import { describe, expect, it } from 'vitest'
import { nativeChatToolLineLabel } from './native-chat-tool-line-label'
import { nativeChatToolLineView } from './native-chat-tool-line-view'

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

  it('links a read, never a listed folder', () => {
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

describe('command disclosure', () => {
  it('opens a running short command before any output exists', () => {
    const view = nativeChatToolLineView({
      type: 'tool-call',
      name: 'Bash',
      state: 'running',
      input: { command: 'git status --short', description: 'Inspect changes' }
    })
    expect(view.hasDetail).toBe(true)
    expect(view.body).toBeUndefined()
    expect(view.label).toMatchObject({ fullCommand: 'git status --short', commandDetail: null })
  })

  it('keeps the full command accessible when metadata accompanies a shortened label', () => {
    const command = `pnpm test ${'src/checkout/payment-validation.test.ts '.repeat(4)}`
    const view = nativeChatToolLineView({
      type: 'tool-call',
      name: 'Bash',
      state: 'running',
      input: { command, description: 'Validate checkout', timeout: 600000 }
    })
    expect(view.hasDetail).toBe(true)
    expect(view.label?.target.length).toBeLessThan(command.trim().length)
    expect(view.label?.commandDetail).toBe(command.trim())
  })
})
