import { describe, expect, it } from 'vitest'
import { getServeFlagTypoError, getServeOptionValidationError } from './serve-option-validation'

describe('getServeOptionValidationError', () => {
  const base = { noPairing: false, recipeJson: false, projectRoot: null }

  it('rejects --mobile-pairing with a bind the mobile offer cannot widen', () => {
    for (const bind of ['127.0.0.1', '100.64.1.20', '::']) {
      expect(getServeOptionValidationError({ ...base, mobilePairing: true, bind })).toMatch(
        /--mobile-pairing needs --bind 0\.0\.0\.0/
      )
    }
  })

  it('allows --mobile-pairing without a narrower bind, and any bind without it', () => {
    expect(getServeOptionValidationError({ ...base, mobilePairing: true })).toBeNull()
    expect(
      getServeOptionValidationError({ ...base, mobilePairing: true, bind: '0.0.0.0' })
    ).toBeNull()
    expect(
      getServeOptionValidationError({ ...base, mobilePairing: false, bind: '127.0.0.1' })
    ).toBeNull()
  })
})

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
