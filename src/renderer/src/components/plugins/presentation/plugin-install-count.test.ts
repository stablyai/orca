import { describe, expect, it } from 'vitest'
import { formatPluginInstallCount, pluginInstallCountLabel } from './plugin-install-count'

describe('plugin install count', () => {
  it('formats counts compactly, like the plugin site', () => {
    expect(formatPluginInstallCount(37)).toBe('37')
    expect(formatPluginInstallCount(1234)).toBe('1.2k')
    expect(formatPluginInstallCount(2_500_000)).toBe('2.5m')
    expect(pluginInstallCountLabel(1234)).toBe('1.2k installs')
  })
})
