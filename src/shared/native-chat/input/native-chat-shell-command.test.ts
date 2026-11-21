import { describe, expect, it } from 'vitest'
import { nativeChatShellCommand } from './native-chat-shell-command'

describe('nativeChatShellCommand', () => {
  it('reads the command after a leading !', () => {
    expect(nativeChatShellCommand('!pwd')).toBe('pwd')
    expect(nativeChatShellCommand('! secrets status')).toBe('secrets status')
    expect(nativeChatShellCommand('  !git status  ')).toBe('git status')
  })

  it('keeps a multi-line command whole', () => {
    expect(nativeChatShellCommand('!echo a\necho b')).toBe('echo a\necho b')
  })

  it('ignores drafts that are not a ! command', () => {
    expect(nativeChatShellCommand('run pwd')).toBeNull()
    expect(nativeChatShellCommand('/model')).toBeNull()
    expect(nativeChatShellCommand('say !pwd')).toBeNull()
    expect(nativeChatShellCommand('!')).toBeNull()
    expect(nativeChatShellCommand('!   ')).toBeNull()
  })
})
