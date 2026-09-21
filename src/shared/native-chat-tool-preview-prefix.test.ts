import { describe, expect, it } from 'vitest'
import { unwrapLoginShellCommand } from './native-chat-tool-preview-prefix'

describe('unwrapLoginShellCommand', () => {
  it('drops the login-shell wrapper the agent reaches a terminal through', () => {
    expect(unwrapLoginShellCommand(`/bin/zsh -lc 'git status --short'`)).toBe('git status --short')
    expect(unwrapLoginShellCommand(`/bin/bash -lc "pnpm test"`)).toBe('pnpm test')
    expect(unwrapLoginShellCommand(`sh -c 'ls'`)).toBe('ls')
    expect(unwrapLoginShellCommand(`C:\\Program Files\\Git\\bin\\bash.exe -lc "ls"`)).toBe('ls')
  })

  it('keeps a command that only happens to mention a shell', () => {
    expect(unwrapLoginShellCommand('git status')).toBe('git status')
    expect(unwrapLoginShellCommand('echo /bin/zsh -lc')).toBe('echo /bin/zsh -lc')
  })

  it('leaves the wrapper alone when the remainder is not one quoted string', () => {
    // A pipeline into the wrapper: stripping the quotes would drop the `| head`.
    expect(unwrapLoginShellCommand(`/bin/zsh -lc 'ls' | head`)).toBe(`/bin/zsh -lc 'ls' | head`)
    expect(unwrapLoginShellCommand(`/bin/zsh -lc "unterminated`)).toBe(`/bin/zsh -lc "unterminated`)
    expect(unwrapLoginShellCommand(`/bin/zsh -lc ls`)).toBe(`/bin/zsh -lc ls`)
  })

  it('keeps quotes that belong to the command itself', () => {
    expect(unwrapLoginShellCommand(`/bin/zsh -lc "rg -n 'needle' src"`)).toBe(`rg -n 'needle' src`)
  })

  it('unwraps a multi-line command without collapsing it', () => {
    expect(unwrapLoginShellCommand(`/bin/zsh -lc 'set -e\ngit push'`)).toBe('set -e\ngit push')
  })
})
