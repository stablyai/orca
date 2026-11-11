// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { defaultLaunchConfig } from './cloud-restart-launch-command'

function withSettings(patch: Record<string, unknown>): void {
  const base = getDefaultSettings('/home/dev')
  useAppStore.setState({ settings: { ...base, ...patch } })
}

describe('defaultLaunchConfig (RA-11d, RST-FLAGS)', () => {
  afterEach(() => {
    useAppStore.setState({ settings: getDefaultSettings('/home/dev') })
  })

  it('no default args set: nothing is sent, so the host projects its own launch profile', () => {
    withSettings({})
    expect(defaultLaunchConfig('claude')).toBeUndefined()
  })

  it('default args are projected like a fresh launch: the bypass permission is kept', () => {
    withSettings({
      agentDefaultArgs: {
        ...getDefaultSettings('/home/dev').agentDefaultArgs,
        claude: '--model opus --effort high'
      },
      agentPermissionDefault: 'full-access'
    })
    const args = defaultLaunchConfig('claude')?.agentArgs ?? ''
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--model opus')
    expect(args).toContain('--effort high')
  })

  it('with permissions set to ask, no bypass flag is added', () => {
    withSettings({
      agentDefaultArgs: {
        ...getDefaultSettings('/home/dev').agentDefaultArgs,
        claude: '--model opus --effort high'
      },
      agentPermissionDefault: 'ask'
    })
    const args = defaultLaunchConfig('claude')?.agentArgs ?? ''
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toContain('--model opus')
  })
})
