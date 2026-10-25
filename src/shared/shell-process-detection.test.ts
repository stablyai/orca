import { describe, expect, it } from 'vitest'
import { titleShowsNoAgent } from './shell-process-detection'

describe('titleShowsNoAgent', () => {
  it.each([
    'MINGW64:/c/Users/dev/repo',
    'MINGW32:/c/repo',
    'MSYS:/home/dev',
    'UCRT64:/c/repo',
    'CLANG64:/c/repo',
    'CLANGARM64:/c/repo'
  ])('reads the Git Bash prompt title %s as the shell', (title) => {
    expect(titleShowsNoAgent(title)).toBe(true)
  })

  it('still reads shell names and the default title as the shell', () => {
    expect(titleShowsNoAgent('zsh')).toBe(true)
    expect(titleShowsNoAgent('bash.exe')).toBe(true)
    expect(titleShowsNoAgent('Terminal 2', 'Terminal 2')).toBe(true)
  })

  it.each(['demo-repo', 'Codex', '⠋ MINGW64:/c/repo', 'MINGW64 notes', 'mingw64:/c/repo', ''])(
    'does not read %j as the shell',
    (title) => {
      expect(titleShowsNoAgent(title)).toBe(false)
    }
  )
})
