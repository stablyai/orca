import { describe, expect, it } from 'vitest'
import {
  buildFileComparePairKey,
  canCompareSelectedFiles,
  formatFileCompareTabLabel,
  orderFileComparePair
} from './file-explorer-file-compare'

describe('file-explorer file compare helpers', () => {
  it('allows compare only for exactly two non-directory nodes', () => {
    expect(
      canCompareSelectedFiles([
        { path: '/a', relativePath: 'a', isDirectory: false },
        { path: '/b', relativePath: 'b', isDirectory: false }
      ])
    ).toBe(true)
    expect(
      canCompareSelectedFiles([{ path: '/a', relativePath: 'a', isDirectory: false }])
    ).toBe(false)
    expect(
      canCompareSelectedFiles([
        { path: '/a', relativePath: 'a', isDirectory: false },
        { path: '/dir', relativePath: 'dir', isDirectory: true }
      ])
    ).toBe(false)
  })

  it('orders pairs so A↔B and B↔A share a key', () => {
    const a = { path: '/repo/b.ts', relativePath: 'b.ts', isDirectory: false }
    const b = { path: '/repo/a.ts', relativePath: 'a.ts', isDirectory: false }
    const [left, right] = orderFileComparePair(a, b)
    expect(left.relativePath).toBe('a.ts')
    expect(right.relativePath).toBe('b.ts')
    expect(buildFileComparePairKey(a.relativePath, b.relativePath)).toBe(
      buildFileComparePairKey(b.relativePath, a.relativePath)
    )
  })

  it('formats a short tab label from basenames', () => {
    expect(formatFileCompareTabLabel('src/a.ts', 'src/b.ts')).toBe('a.ts ↔ b.ts')
  })
})
