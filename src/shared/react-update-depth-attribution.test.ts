import { describe, expect, it } from 'vitest'
import {
  UNRELIABLE_BOUNDARY_ATTRIBUTION,
  getReactErrorBoundaryAttribution
} from './react-update-depth-attribution'

describe('react update depth attribution', () => {
  it('matches the minified production digest for error #185', () => {
    expect(
      getReactErrorBoundaryAttribution(
        new Error(
          'Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'
        )
      )
    ).toBe(UNRELIABLE_BOUNDARY_ATTRIBUTION)
  })

  it('matches the legacy error-decoder invariant form', () => {
    expect(
      getReactErrorBoundaryAttribution(
        new Error(
          'Minified React error #185; visit https://reactjs.org/docs/error-decoder.html?invariant=185 for the full message.'
        )
      )
    ).toBe(UNRELIABLE_BOUNDARY_ATTRIBUTION)
  })

  it('matches the development message', () => {
    expect(
      getReactErrorBoundaryAttribution(new Error('Maximum update depth exceeded. This can happen…'))
    ).toBe(UNRELIABLE_BOUNDARY_ATTRIBUTION)
  })

  it('matches a non-Error thrown value carrying the digest', () => {
    expect(getReactErrorBoundaryAttribution('Minified React error #185; visit https://x')).toBe(
      UNRELIABLE_BOUNDARY_ATTRIBUTION
    )
  })

  it('does not match other React error numbers, including #185 prefixes', () => {
    expect(
      getReactErrorBoundaryAttribution(new Error('Minified React error #310; visit https://x'))
    ).toBeUndefined()
    expect(
      getReactErrorBoundaryAttribution(new Error('Minified React error #1852; visit https://x'))
    ).toBeUndefined()
    expect(
      getReactErrorBoundaryAttribution(new Error('Minified React error #18; visit https://x'))
    ).toBeUndefined()
  })

  it('does not match unrelated errors', () => {
    expect(getReactErrorBoundaryAttribution(new TypeError('x is not a function'))).toBeUndefined()
    expect(getReactErrorBoundaryAttribution(null)).toBeUndefined()
  })
})
