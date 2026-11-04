import { describe, expect, it } from 'vitest'
import { getServeFlagTypoError } from './serve-option-validation'

describe('getServeFlagTypoError', () => {
  it('accepts exact serve flags and arbitrary Chromium switches', () => {
    expect(
      getServeFlagTypoError([
        '/opt/orca/orca-ide',
        '--serve',
        '--serve-no-pairing',
        '--disable-gpu',
        '--disable-features=Vulkan',
        '--no-parent'
      ])
    ).toBeNull()
  })

  it.each(['--no-pair', '--no-pairng', '--no-paring', '--mobile-pairng'])(
    'suggests the intended pairing flag for %s',
    (flag) => {
      expect(getServeFlagTypoError(['/opt/orca/orca-ide', '--serve', flag])).toMatch(
        /Unknown flag .*Did you mean --(?:no-pairing|mobile-pairing)\?/i
      )
    }
  )

  it('does not reinterpret tokens after --', () => {
    expect(getServeFlagTypoError(['/opt/orca/orca-ide', '--serve', '--', '--no-pairng'])).toBeNull()
  })

  it('does not inspect an equals-form value as a flag', () => {
    expect(
      getServeFlagTypoError(['/opt/orca/orca-ide', '--serve-pairing-address=--no-pairng'])
    ).toBeNull()
  })

  it('keeps flag-shaped space values subject to typo validation', () => {
    expect(
      getServeFlagTypoError(['/opt/orca/orca-ide', '--serve-pairing-address', '--no-pairng'])
    ).toMatch(/Unknown flag --no-pairng.*--no-pairing/i)
  })
})
