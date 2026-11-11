import { describe, expect, it } from 'vitest'
import { classifyPluginGitAccessFailure } from './plugin-git-access-failure'

const HOST = 'the Orca host (build-box)'

describe('classifyPluginGitAccessFailure', () => {
  it('leaves other failures alone and strips credentials from the detail', () => {
    expect(
      classifyPluginGitAccessFailure({
        error: 'fatal: unable to access: Could not resolve host: github.com',
        url: 'https://github.com/acme/notes',
        executionHost: HOST
      })
    ).toBeNull()
    expect(
      classifyPluginGitAccessFailure({
        error: "fatal: Authentication failed for 'https://user:tok3n@github.com/acme/notes'",
        url: 'https://github.com/acme/notes',
        executionHost: HOST
      })?.detail
    ).not.toContain('tok3n')
  })
})
