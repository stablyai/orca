import { describe, expect, it } from 'vitest'
import { getServeFlagTypoError, getServeOptionValidationError } from './serve-option-validation'

const validOptions = {
  noPairing: false,
  mobilePairing: false,
  recipeJson: false,
  projectRoot: null
}

describe('getServeOptionValidationError', () => {
  it('accepts compatible options', () => {
    expect(getServeOptionValidationError(validOptions)).toBeNull()
  })

  it.each([
    [{ noPairing: true, mobilePairing: true }, /either --mobile-pairing or --no-pairing/i],
    [
      { recipeJson: true, noPairing: true, projectRoot: '/tmp/repo' },
      /requires runtime pairing.*--no-pairing/i
    ],
    [
      { recipeJson: true, mobilePairing: true, projectRoot: '/tmp/repo' },
      /requires runtime pairing.*--mobile-pairing/i
    ],
    [{ recipeJson: true }, /requires --project-root/i]
  ])('rejects incompatible options', (override, expected) => {
    expect(
      getServeOptionValidationError({ ...validOptions, ...override } as typeof validOptions)
    ).toMatch(expected)
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
