import { describe, expect, it } from 'vitest'
import {
  FALLBACK_MOBILE_SYSTEM_MONITOR_IDS,
  getSystemMonitorDescriptor,
  getSystemMonitorProbeBinaries,
  isSystemMonitorId,
  KNOWN_SYSTEM_MONITORS,
  resolveDetectedSystemMonitorIds,
  resolveSystemMonitorDescriptors
} from './system-monitors'

describe('system-monitors catalog', () => {
  it('defines unique monitor ids with non-empty binaries and commands', () => {
    const ids = new Set<string>()
    for (const monitor of KNOWN_SYSTEM_MONITORS) {
      expect(ids.has(monitor.id)).toBe(false)
      ids.add(monitor.id)
      expect(monitor.binary.trim().length).toBeGreaterThan(0)
      expect(monitor.command.trim().length).toBeGreaterThan(0)
      expect(getSystemMonitorDescriptor(monitor.id)).toBe(monitor)
      expect(isSystemMonitorId(monitor.id)).toBe(true)
    }
    expect(isSystemMonitorId('unknown-monitor')).toBe(false)
  })

  it('filters Unix-only monitors on native win32 while preserving them on linux and wsl', () => {
    const winBinaries = getSystemMonitorProbeBinaries('win32')
    expect(winBinaries).not.toContain('top')
    expect(winBinaries).not.toContain('radeontop')
    expect(winBinaries).not.toContain('iotop')
    expect(winBinaries).toContain('btop')
    expect(winBinaries).toContain('lazydocker')
    expect(winBinaries).toContain('docker')

    const linuxDetected = resolveDetectedSystemMonitorIds(
      ['btop', 'htop', 'lazydocker', 'ctop', 'docker', 'radeontop', 'ncdu', 'duf', 'top'],
      'linux'
    )
    expect(linuxDetected).toEqual([
      'btop',
      'htop',
      'lazydocker',
      'ctop',
      'docker-stats',
      'radeontop',
      'ncdu',
      'duf',
      'top'
    ])

    const wslDetected = resolveDetectedSystemMonitorIds(['top', 'iotop', 'docker'], 'wsl')
    expect(wslDetected).toEqual(['docker-stats', 'iotop', 'top'])

    const winDetected = resolveDetectedSystemMonitorIds(['top', 'btop', 'docker'], 'win32')
    expect(winDetected).toEqual(['btop', 'docker-stats'])
  })

  it('deduplicates and drops unknown entries when resolving descriptors from wire replies', () => {
    const resolved = resolveSystemMonitorDescriptors([
      'lazydocker',
      'not-a-monitor',
      42,
      'btop',
      'lazydocker',
      'docker-stats'
    ])
    expect(resolved.map((entry) => entry.id)).toEqual(['lazydocker', 'btop', 'docker-stats'])

    const fallback = resolveSystemMonitorDescriptors(FALLBACK_MOBILE_SYSTEM_MONITOR_IDS)
    expect(fallback.length).toBe(FALLBACK_MOBILE_SYSTEM_MONITOR_IDS.length)
  })
})
