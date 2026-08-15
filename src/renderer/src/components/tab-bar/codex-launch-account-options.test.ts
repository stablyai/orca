import { describe, expect, it } from 'vitest'
import { buildCodexLaunchAccountOptions } from './codex-launch-account-options'

const accounts = [
  {
    id: 'host-a',
    email: 'host@example.com',
    workspaceLabel: 'Host workspace',
    managedHomeRuntime: 'host' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  },
  {
    id: 'wsl-a',
    email: 'wsl@example.com',
    managedHomeRuntime: 'wsl' as const,
    wslDistro: 'Ubuntu',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
]

describe('buildCodexLaunchAccountOptions', () => {
  it('keeps omission as current default and exposes UUIDs as canonical selectors', () => {
    const options = buildCodexLaunchAccountOptions(accounts, { runtime: 'host' })

    expect(options.map(({ key }) => key)).toEqual(['current-default', 'system-default', 'host-a'])
    expect(options[0].providerAccountRef).toBeUndefined()
    expect(options[1].providerAccountRef).toEqual({
      provider: 'codex',
      accountId: null,
      runtime: 'host'
    })
    expect(options[2]).toMatchObject({
      label: 'Host workspace',
      description: 'host@example.com · host-a',
      providerAccountRef: { accountId: 'host-a', runtime: 'host' }
    })
  })

  it('filters managed accounts by WSL lane without case-sensitive distro drift', () => {
    const options = buildCodexLaunchAccountOptions(accounts, {
      runtime: 'wsl',
      wslDistro: 'ubuntu'
    })

    expect(options.map(({ key }) => key)).toEqual(['current-default', 'system-default', 'wsl-a'])
    expect(options[1].providerAccountRef).toMatchObject({
      accountId: null,
      runtime: 'wsl',
      wslDistro: 'ubuntu'
    })
    expect(options[2].providerAccountRef).toMatchObject({
      accountId: 'wsl-a',
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
  })
})
