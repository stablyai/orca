import type { MemorySnapshot } from '../../../../shared/process-stats-types'
import { getBrowserPlatform } from './web-storage'

export function createEmptyMemorySnapshot(): MemorySnapshot {
  const emptyUsage = { cpu: 0, memory: 0 }
  return {
    app: { ...emptyUsage, main: emptyUsage, renderer: emptyUsage, other: emptyUsage, history: [] },
    worktrees: [],
    host: {
      totalMemory: 0,
      freeMemory: 0,
      availableMemory: 0,
      availableMemorySource: 'free-memory',
      usedMemory: 0,
      memoryUsagePercent: 0,
      cpuCoreCount: navigator.hardwareConcurrency || 1,
      loadAverage1m: 0
    },
    processMemoryMetric: getBrowserPlatform() === 'win32' ? 'working-set' : 'rss',
    totalCpu: 0,
    totalMemory: 0,
    collectedAt: Date.now()
  }
}
