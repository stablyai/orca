import { describe, expect, it } from 'vitest'
import { getProjectRemoteDisplay } from './project-remote-display'

function webUrlFor(remoteUrl: string): string | null | undefined {
  return getProjectRemoteDisplay({
    gitRemoteIdentity: { canonicalKey: 'unused', remoteName: 'origin', remoteUrl }
  })?.webUrl
}

describe('getProjectRemoteDisplay', () => {
  it('keeps the http(s) remote scheme and port but never its credentials', () => {
    expect(webUrlFor('http://token@git.example.lan:3500/acme/widgets.git')).toBe(
      'http://git.example.lan:3500/acme/widgets'
    )
    expect(webUrlFor('https://user:secret@gitlab.example.com:8929/group/team/repo.git')).toBe(
      'https://gitlab.example.com:8929/group/team/repo'
    )
  })
})
