import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: vi.fn() }))

import { describeRemoteOpenUrlRequest } from './remote-open-url-approval'

const state: Parameters<typeof describeRemoteOpenUrlRequest>[1] = {
  sshTargetLabels: new Map([['ssh-1', 'build-box']]),
  removedSshTargetLabels: new Map([['ssh-old', 'retired-box']])
}

describe('describeRemoteOpenUrlRequest', () => {
  it('names the requesting host by its label and shows only the site', () => {
    expect(
      describeRemoteOpenUrlRequest(
        { url: 'https://auth.openai.com/codex/device?x=1', sshTargetId: 'ssh-1' },
        state
      )
    ).toEqual({ hostLabel: 'build-box', site: 'auth.openai.com' })
    expect(
      describeRemoteOpenUrlRequest({ url: 'https://a.example/', sshTargetId: 'ssh-old' }, state)
        ?.hostLabel
    ).toBe('retired-box')
  })

  it('shows the site, not the userinfo, when a URL hides its real host', () => {
    expect(
      describeRemoteOpenUrlRequest(
        { url: 'https://auth.openai.com@evil.example/login', sshTargetId: 'ssh-1' },
        state
      )?.site
    ).toBe('evil.example')
  })

  it('refuses anything that is not http(s)', () => {
    expect(
      describeRemoteOpenUrlRequest({ url: 'file:///etc/passwd', sshTargetId: 'ssh-1' }, state)
    ).toBeNull()
    expect(
      describeRemoteOpenUrlRequest({ url: 'not a url', sshTargetId: 'ssh-1' }, state)
    ).toBeNull()
  })
})
