import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getSourceControlAiControllerDiscoveryHostKey } from './use-source-control-ai'

describe('getSourceControlAiControllerDiscoveryHostKey', () => {
  it('keys generation settings by the active workspace connection', () => {
    const settings = getDefaultSettings('/tmp')

    expect(getSourceControlAiControllerDiscoveryHostKey(settings, null)).toBe('local')
    expect(getSourceControlAiControllerDiscoveryHostKey(settings, undefined)).toBe('unknown')
    expect(getSourceControlAiControllerDiscoveryHostKey(settings, 'ssh-1')).toBe('ssh:ssh-1')
  })

  it('uses the active runtime environment before SSH connection scope', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      activeRuntimeEnvironmentId: 'env-1'
    }

    expect(getSourceControlAiControllerDiscoveryHostKey(settings, 'ssh-1')).toBe('runtime:env-1')
  })
})
