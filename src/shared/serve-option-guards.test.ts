import { describe, expect, it } from 'vitest'
import { getServeFlagTypoError, getServeOptionGuardError } from './serve-option-guards'

describe('getServeOptionGuardError', () => {
  it('accepts a clean pairing-off launch', () => {
    expect(
      getServeOptionGuardError({
        noPairing: true,
        mobilePairing: false,
        recipeJson: false,
        projectRoot: null
      })
    ).toBeNull()
  })

  it('rejects no-pairing with mobile-pairing', () => {
    expect(
      getServeOptionGuardError({
        noPairing: true,
        mobilePairing: true,
        recipeJson: false,
        projectRoot: null
      })
    ).toMatch(/either --mobile-pairing or --no-pairing/i)
  })

  it('rejects recipe-json with no-pairing', () => {
    expect(
      getServeOptionGuardError({
        noPairing: true,
        mobilePairing: false,
        recipeJson: true,
        projectRoot: '/tmp/project'
      })
    ).toMatch(/requires runtime pairing.*--no-pairing/i)
  })

  it('rejects recipe-json with mobile-pairing', () => {
    expect(
      getServeOptionGuardError({
        noPairing: false,
        mobilePairing: true,
        recipeJson: true,
        projectRoot: '/tmp/project'
      })
    ).toMatch(/requires runtime pairing.*--mobile-pairing/i)
  })

  it('rejects recipe-json without project-root', () => {
    expect(
      getServeOptionGuardError({
        noPairing: false,
        mobilePairing: false,
        recipeJson: true,
        projectRoot: null
      })
    ).toMatch(/requires --project-root/i)
  })
})

describe('getServeFlagTypoError', () => {
  it('accepts known serve flags and unrelated Chromium switches', () => {
    expect(
      getServeFlagTypoError([
        '/opt/Orca/orca-ide',
        '--serve',
        '--serve-port',
        '6768',
        '--serve-no-pairing',
        '--disable-gpu',
        '--enable-features=Foo'
      ])
    ).toBeNull()
  })

  it('rejects a --no-pairing typo that would silently keep pairing on', () => {
    expect(getServeFlagTypoError(['/AppRun', 'serve', '--port', '6768', '--no-pairng'])).toMatch(
      /Unknown flag --no-pairng.*--no-pairing/i
    )
  })

  it('rejects a one-letter --no-pairing omission (--no-paring)', () => {
    expect(getServeFlagTypoError(['/opt/Orca/orca-ide', 'serve', '--no-paring'])).toMatch(
      /Unknown flag --no-paring.*--no-pairing/i
    )
  })

  it('rejects a --mobile-pairing typo', () => {
    expect(getServeFlagTypoError(['orca', '--serve', '--mobile-pairng'])).toMatch(
      /Unknown flag --mobile-pairng.*--mobile-pairing/i
    )
  })

  it('does not flag the exact known forms', () => {
    expect(
      getServeFlagTypoError(['orca', 'serve', '--no-pairing', '--mobile-pairing', '--recipe-json'])
    ).toBeNull()
  })

  it('does not scan past the option terminator', () => {
    expect(getServeFlagTypoError(['/AppRun', 'serve', '--', '--no-pairng'])).toBeNull()
  })
})
