import { describe, expect, it } from 'vitest'
import { simulatorRuntimeLabel } from './simulator-runtime-label'

describe('simulatorRuntimeLabel', () => {
  it('turns simctl runtime identifiers into OS versions and ignores other details', () => {
    expect(simulatorRuntimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-26-0')).toBe('iOS 26.0')
    expect(simulatorRuntimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-18-6-1')).toBe(
      'iOS 18.6.1'
    )
    expect(simulatorRuntimeLabel('com.apple.CoreSimulator.SimRuntime.watchOS-11-0')).toBe(
      'watchOS 11.0'
    )
    expect(simulatorRuntimeLabel('avd')).toBeUndefined()
    expect(simulatorRuntimeLabel('Android')).toBeUndefined()
    expect(simulatorRuntimeLabel(undefined)).toBeUndefined()
  })
})
