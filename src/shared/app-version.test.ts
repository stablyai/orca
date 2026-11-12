import { describe, expect, it } from 'vitest'
import { parseCliVersion } from './app-version'

describe('parseCliVersion', () => {
  it('reads a version that ends a sentence', () => {
    expect(
      parseCliVersion("GitHub Copilot CLI 1.0.109.\nRun 'copilot update' to check for updates.")
    ).toBe('1.0.109')
  })

  it('rejects a four-part version', () => {
    expect(parseCliVersion('tool 1.2.3.4')).toBeNull()
  })
})
