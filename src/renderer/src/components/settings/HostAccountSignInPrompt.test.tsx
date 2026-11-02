import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HostAccountSignInStatus } from '../../../../shared/host-account-sign-in-types'

const client = vi.hoisted(() => {
  const state: { running: boolean; status: HostAccountSignInStatus | null } = {
    running: false,
    status: null
  }
  return state
})

vi.mock('@/runtime/runtime-host-account-sign-in-client', () => ({
  cancelHostAccountSignIn: vi.fn(),
  isLostHostAnswer: () => false,
  hasHostAccountSignIn: () => client.running,
  readHostAccountSignIn: () => client.status,
  submitHostAccountSignInCode: vi.fn(),
  subscribeHostAccountSignIns: () => () => {}
}))

import { HostAccountSignInPrompt } from './HostAccountSignInPrompt'

const OWNER = { kind: 'environment', environmentId: 'server' } as const

function render(): string {
  return renderToStaticMarkup(
    <HostAccountSignInPrompt owner={OWNER} provider="claude" hostLabel="Server" />
  )
}

describe('HostAccountSignInPrompt', () => {
  it('shows nothing while no sign-in runs on this server', () => {
    client.running = false
    expect(render()).toBe('')
  })

  it('keeps Cancel for a sign-in still running after Settings reopens', () => {
    client.running = true
    client.status = null
    const markup = render()
    expect(markup).toContain('Starting sign-in on Server')
    expect(markup).toContain('Cancel')
  })

  it('offers only the provider’s own sign-in page, and a box for Claude’s code', () => {
    client.running = true
    const prompt = { userCode: null, needsCode: true }
    client.status = {
      flowId: 'f',
      provider: 'claude',
      revision: 2,
      phase: 'waiting',
      prompt: { ...prompt, url: 'https://claude.com/cai/oauth/authorize?code=true' }
    }
    expect(render()).toContain('https://claude.com/cai/oauth/authorize?code=true')
    expect(render()).toContain('Paste it here')
    client.status = { ...client.status, prompt: { ...prompt, url: 'https://evil.test/' } }
    expect(render()).not.toContain('evil.test')
  })
})
