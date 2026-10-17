import { describe, expect, it, vi } from 'vitest'
import {
  resolveSshHostProxyEnvForTarget,
  sshTargetIdForExecutionHost,
  withSshHostProxyEnv
} from './ssh-host-proxy-env'

const environments = [
  { id: 'env-1', orcadDeployment: { sshTargetId: 'target-1' } },
  { id: 'env-2' }
]

describe('sshTargetIdForExecutionHost', () => {
  it('reads the target off a direct SSH host', () => {
    expect(sshTargetIdForExecutionHost('ssh:target-1', environments)).toBe('target-1')
  })

  it('reads the target a managed server runs on', () => {
    expect(sshTargetIdForExecutionHost('runtime:env-1', environments)).toBe('target-1')
  })

  it('answers null for a runtime host that is not a managed server', () => {
    expect(sshTargetIdForExecutionHost('runtime:env-2', environments)).toBeNull()
    expect(sshTargetIdForExecutionHost('runtime:missing', environments)).toBeNull()
  })

  it('answers null without an SSH host', () => {
    expect(sshTargetIdForExecutionHost('local', environments)).toBeNull()
    expect(sshTargetIdForExecutionHost(undefined, environments)).toBeNull()
  })

  it('answers null when this client has no environment catalog yet', () => {
    expect(sshTargetIdForExecutionHost('runtime:env-1', undefined)).toBeNull()
  })
})

describe('withSshHostProxyEnv', () => {
  it('lets the host proxy outrank a forwarded pane env', () => {
    expect(
      withSshHostProxyEnv(
        { ORCA_TAB_ID: 'tab-1', HTTP_PROXY: 'http://stale:1' },
        {
          HTTP_PROXY: 'http://proxy.test:3128'
        }
      )
    ).toEqual({ ORCA_TAB_ID: 'tab-1', HTTP_PROXY: 'http://proxy.test:3128' })
  })

  it('leaves the pane env untouched when the host has no proxy', () => {
    const env = { ORCA_TAB_ID: 'tab-1' }
    expect(withSshHostProxyEnv(env, {})).toBe(env)
    expect(withSshHostProxyEnv(undefined, {})).toBeUndefined()
  })
})

describe('resolveSshHostProxyEnvForTarget', () => {
  it('builds the proxy env from the target own settings', async () => {
    const listTargets = vi.fn(async () => [
      { id: 'other', httpProxyUrl: 'http://other.lan:8080' },
      {
        id: 'target-1',
        httpProxyUrl: 'http://proxy.lan:3128',
        httpProxyBypassRules: 'localhost, *.internal'
      }
    ])

    await expect(
      resolveSshHostProxyEnvForTarget({ targetId: 'target-1', listTargets })
    ).resolves.toEqual({
      HTTP_PROXY: 'http://proxy.lan:3128',
      HTTPS_PROXY: 'http://proxy.lan:3128',
      ALL_PROXY: 'http://proxy.lan:3128',
      http_proxy: 'http://proxy.lan:3128',
      https_proxy: 'http://proxy.lan:3128',
      all_proxy: 'http://proxy.lan:3128',
      NO_PROXY: 'localhost,*.internal',
      no_proxy: 'localhost,*.internal'
    })
  })

  it('builds nothing for a host whose target has no proxy', async () => {
    await expect(
      resolveSshHostProxyEnvForTarget({
        targetId: 'target-1',
        listTargets: async () => [{ id: 'target-1' }]
      })
    ).resolves.toEqual({})
  })
})
