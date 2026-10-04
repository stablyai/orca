import { expect, it } from 'vitest'
import { getOpenCodeCliCapabilities, parseOpenCodeCliVersion } from './opencode-cli-version'

it.each(['1.1.23', 'opencode v2.0.16', '2.0.0-beta.1+build'])('parses CLI output %s', (output) => {
  expect(parseOpenCodeCliVersion(output)).toBe(output.replace(/^opencode v/, ''))
})
it.each([null, '', 'Error 2.0.16', '1.1', '2.0.16\nwarning'])(
  'does not mistake other output for a version',
  (output) => {
    expect(parseOpenCodeCliVersion(output)).toBeNull()
  }
)
it('keeps future versions unknown instead of assuming a plugin loader or prompt policy', () => {
  expect(getOpenCodeCliCapabilities('3.0.0')).toEqual({
    version: '3.0.0',
    pluginApi: 'unknown',
    promptMode: 'unknown'
  })
  expect(getOpenCodeCliCapabilities('1.1.23')).toEqual({
    version: '1.1.23',
    pluginApi: 'v1',
    promptMode: 'submit'
  })
  expect(getOpenCodeCliCapabilities('opencode v2.0.16')).toEqual({
    version: '2.0.16',
    pluginApi: 'v2',
    promptMode: 'prefill'
  })
})

it('does not opt unverified v2 builds into an extra prompt submission', () => {
  expect(getOpenCodeCliCapabilities('2.0.17').promptMode).toBe('unknown')
  expect(getOpenCodeCliCapabilities('2.0.16-beta').promptMode).toBe('unknown')
})
