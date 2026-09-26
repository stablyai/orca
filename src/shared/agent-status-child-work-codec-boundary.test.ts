import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree } from './source-scan/source-tree-scan'

const SOURCE_ROOT = resolve(__dirname, '..')
const CODEC_IMPORT = /from\s+['"][^'"]*\/agent-status-child-work-codec['"]/

// The host's own store and admission path. The codec rejects a whole record over one unknown key,
// so a reader of another build's records or views must use a permissive or negotiated decoder.
const HOST_INTERNAL_IMPORTERS = [
  'shared/agent-status-child-work-admission-core.ts',
  'shared/agent-status-child-work-admission-operations.ts',
  'shared/agent-status-child-work-alias.ts',
  'shared/agent-status-child-work-resume.ts',
  'shared/agent-status-store-codec.ts',
  'shared/agent-status-store-mutation.ts',
  'shared/agent-status-store-state.ts'
]

describe('child-work record codec boundary', () => {
  it('is imported only by the host store and admission modules', () => {
    const importers = scanSourceTree(SOURCE_ROOT)
      .filter((file) => CODEC_IMPORT.test(file.source))
      .map((file) => file.relativePath)
      .sort()
    expect(importers).toEqual(HOST_INTERNAL_IMPORTERS)
  })
})
