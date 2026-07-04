import { describe, expect, it } from 'vitest'
import {
  isSafeDiagnosticBundleOutputPath,
  parseSafeDiagnosticBundleOutputPath
} from './diagnostic-bundle-output-path-policy'

describe('diagnostic bundle output path policy', () => {
  it('accepts relative filenames and subpaths', () => {
    expect(parseSafeDiagnosticBundleOutputPath('bundle.zip')).toEqual(['bundle.zip'])
    expect(parseSafeDiagnosticBundleOutputPath('nested\\bundle.zip')).toEqual([
      'nested',
      'bundle.zip'
    ])
    expect(parseSafeDiagnosticBundleOutputPath('./nested/bundle.zip')).toEqual([
      'nested',
      'bundle.zip'
    ])
  })

  it('rejects absolute and traversal paths', () => {
    for (const output of [
      '/tmp/bundle.zip',
      '\\\\server\\share\\bundle.zip',
      'C:\\tmp\\bundle.zip',
      '../bundle.zip',
      'nested/../bundle.zip'
    ]) {
      expect(isSafeDiagnosticBundleOutputPath(output)).toBe(false)
    }
  })

  it('rejects null bytes and colon-bearing segments', () => {
    for (const output of ['bundle\0.zip', 'nested/logs:bundle.zip']) {
      expect(parseSafeDiagnosticBundleOutputPath(output)).toBeNull()
    }
  })
})
