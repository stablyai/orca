import { expect, it } from 'vitest'
import { parseOpenCodeCliVersion } from './opencode-cli-version'

it.each(['1.1.23', 'opencode v2.0.12', 'opencode v2.0.16', '2.0.0-beta.1+build'])(
  'parses CLI output %s',
  (output) => {
    expect(parseOpenCodeCliVersion(output)).toBe(output.replace(/^opencode v/, ''))
  }
)
it.each([null, '', 'Error 2.0.16', '1.1', '2.0.16\nwarning'])(
  'does not mistake other output for a version',
  (output) => {
    expect(parseOpenCodeCliVersion(output)).toBeNull()
  }
)
