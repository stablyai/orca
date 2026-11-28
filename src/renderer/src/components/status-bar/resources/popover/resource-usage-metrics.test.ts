import { expect, it } from 'vitest'
import { formatMemoryCompact } from './resource-usage-metrics'

const MB = 1024 * 1024
const GB = 1024 * MB

it('rounds to whole MB first and keeps GB labels short', () => {
  const cases: [number, string][] = [
    [1, '0 MB'],
    [380 * MB, '380 MB'],
    [1023.4 * MB, '1023 MB'],
    [1023.6 * MB, '1.0 GB'],
    [12.34 * GB, '12.3 GB'],
    [99.94 * GB, '99.9 GB'],
    [99.96 * GB, '100 GB'],
    [512 * GB, '512 GB']
  ]
  for (const [bytes, label] of cases) {
    expect(formatMemoryCompact(bytes)).toBe(label)
  }
})
