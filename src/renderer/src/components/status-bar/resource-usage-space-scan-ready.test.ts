import { describe, expect, it } from 'vitest'
import {
  resolveResourceUsageSpaceScanReady,
  type ResourceUsageSpaceScanSnapshot
} from './resource-usage-space-scan-ready'

const baseSnapshot: ResourceUsageSpaceScanSnapshot = {
  ready: false,
  previousScanning: false,
  lastSeenScannedAt: null
}

describe('resolveResourceUsageSpaceScanReady', () => {
  it('marks Space results ready when a scan finishes away from the resource popover and Space page', () => {
    expect(
      resolveResourceUsageSpaceScanReady({
        snapshot: { ...baseSnapshot, previousScanning: true },
        runtimeEnvironmentActive: false,
        open: false,
        activeView: 'terminal',
        scannedAt: 100,
        scanning: false
      })
    ).toEqual({
      ready: true,
      previousScanning: false,
      lastSeenScannedAt: 100
    })
  })

  it('does not show the ready handoff when results finish while already visible', () => {
    expect(
      resolveResourceUsageSpaceScanReady({
        snapshot: { ...baseSnapshot, previousScanning: true },
        runtimeEnvironmentActive: false,
        open: true,
        activeView: 'terminal',
        scannedAt: 100,
        scanning: false
      })
    ).toEqual({
      ready: false,
      previousScanning: false,
      lastSeenScannedAt: 100
    })

    expect(
      resolveResourceUsageSpaceScanReady({
        snapshot: { ...baseSnapshot, previousScanning: true },
        runtimeEnvironmentActive: false,
        open: false,
        activeView: 'space',
        scannedAt: 100,
        scanning: false
      }).ready
    ).toBe(false)
  })

  it('clears the handoff once the popover or Space page is opened', () => {
    const readySnapshot = {
      ready: true,
      previousScanning: false,
      lastSeenScannedAt: 100
    }

    expect(
      resolveResourceUsageSpaceScanReady({
        snapshot: readySnapshot,
        runtimeEnvironmentActive: false,
        open: true,
        activeView: 'terminal',
        scannedAt: 100,
        scanning: false
      })
    ).toEqual({
      ready: false,
      previousScanning: false,
      lastSeenScannedAt: 100
    })

    expect(
      resolveResourceUsageSpaceScanReady({
        snapshot: readySnapshot,
        runtimeEnvironmentActive: false,
        open: false,
        activeView: 'space',
        scannedAt: 100,
        scanning: false
      }).ready
    ).toBe(false)
  })

  it('does not announce the same scan completion twice', () => {
    const result = resolveResourceUsageSpaceScanReady({
      snapshot: {
        ready: false,
        previousScanning: true,
        lastSeenScannedAt: 100
      },
      runtimeEnvironmentActive: false,
      open: false,
      activeView: 'terminal',
      scannedAt: 100,
      scanning: false
    })

    expect(result.ready).toBe(false)
    expect(result.lastSeenScannedAt).toBe(100)
  })

  it('hides local Space scan handoffs while a remote runtime is active', () => {
    expect(
      resolveResourceUsageSpaceScanReady({
        snapshot: {
          ready: true,
          previousScanning: true,
          lastSeenScannedAt: 100
        },
        runtimeEnvironmentActive: true,
        open: false,
        activeView: 'terminal',
        scannedAt: 200,
        scanning: true
      })
    ).toEqual({
      ready: false,
      previousScanning: false,
      lastSeenScannedAt: 100
    })
  })

  it('tracks scanning starts without changing readiness', () => {
    expect(
      resolveResourceUsageSpaceScanReady({
        snapshot: baseSnapshot,
        runtimeEnvironmentActive: false,
        open: false,
        activeView: 'terminal',
        scannedAt: null,
        scanning: true
      })
    ).toEqual({
      ready: false,
      previousScanning: true,
      lastSeenScannedAt: null
    })
  })
})
