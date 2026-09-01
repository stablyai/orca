import { describe, expect, it } from 'vitest'
import { editorSuppressedGitEnv } from './git-sequencer-editor-env'

describe('editorSuppressedGitEnv', () => {
  it('pins GIT_EDITOR to a no-op so --continue never waits on an editor', () => {
    expect(editorSuppressedGitEnv({ PATH: '/usr/bin' }, 'darwin').GIT_EDITOR).toBe('true')
  })

  it('overrides an ambient editor rather than deferring to it', () => {
    expect(editorSuppressedGitEnv({ GIT_EDITOR: 'vim' }, 'linux').GIT_EDITOR).toBe('true')
  })

  it('forwards GIT_EDITOR across the WSL boundary on win32', () => {
    expect(editorSuppressedGitEnv({ WSLENV: 'FOO/p' }, 'win32').WSLENV).toBe('FOO/p:GIT_EDITOR')
  })

  it('does not add GIT_EDITOR to WSLENV twice', () => {
    const once = editorSuppressedGitEnv({ WSLENV: 'GIT_EDITOR' }, 'win32')
    expect(once.WSLENV).toBe('GIT_EDITOR')
  })

  it('leaves WSLENV alone off win32', () => {
    expect(editorSuppressedGitEnv({ PATH: '/usr/bin' }, 'darwin').WSLENV).toBeUndefined()
    expect(editorSuppressedGitEnv({ WSLENV: 'FOO/p' }, 'linux').WSLENV).toBe('FOO/p')
  })

  it('does not mutate the input env', () => {
    const input: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    editorSuppressedGitEnv(input, 'win32')
    expect(input.GIT_EDITOR).toBeUndefined()
    expect(input.WSLENV).toBeUndefined()
  })
})
