import { describe, expect, it } from 'vitest'
import { classifyPluginGitAccessFailure } from './plugin-git-access-failure'

const HOST = 'the Orca host (build-box)'

describe('classifyPluginGitAccessFailure', () => {
  it('explains a private GitHub repository over HTTPS with gh on the named host', () => {
    const failure = classifyPluginGitAccessFailure({
      error:
        "Cloning into 'repository'...\nremote: Repository not found.\nfatal: repository 'https://github.com/acme/private-notes/' not found",
      url: 'https://github.com/acme/private-notes',
      executionHost: HOST
    })

    expect(failure).toMatchObject({
      transport: 'https',
      gitHost: 'github.com',
      executionHost: HOST
    })
    expect(failure?.nextSteps[0]).toBe(
      `On ${HOST}, sign Git in to GitHub without a prompt: \`gh auth login\` then \`gh auth setup-git\` (or any Git credential helper).`
    )
    expect(failure?.nextSteps[1]).toContain('git@github.com:acme/private-notes.git')
  })

  it('recognises a disabled terminal prompt and an SSH key refusal', () => {
    expect(
      classifyPluginGitAccessFailure({
        error: "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled",
        url: 'https://gitlab.com/acme/tools/notes',
        executionHost: HOST
      })?.nextSteps[0]
    ).toContain('glab auth login')
    const ssh = classifyPluginGitAccessFailure({
      error:
        'git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      url: 'git@example.com:acme/notes.git',
      executionHost: HOST
    })
    expect(ssh?.transport).toBe('ssh')
    expect(ssh?.nextSteps[0]).toContain('ssh-agent')
  })

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
