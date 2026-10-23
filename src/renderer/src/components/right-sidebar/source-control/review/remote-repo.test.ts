import { describe, expect, it } from 'vitest'
import { parseRemoteRepo } from './remote-repo'

describe('parseRemoteRepo', () => {
  it('treats ssh.bitbucket.org remotes as Bitbucket with bitbucket.org web links', () => {
    const expected = {
      provider: 'bitbucket',
      path: 'team/project',
      webBaseUrl: 'https://bitbucket.org/team/project'
    }
    expect(parseRemoteRepo('ssh://git@ssh.bitbucket.org/team/project.git')).toEqual(expected)
    expect(parseRemoteRepo('git@ssh.bitbucket.org:team/project.git')).toEqual(expected)
  })
})
