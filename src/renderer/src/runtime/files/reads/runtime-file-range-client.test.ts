import { describe, expect, it } from 'vitest'
import { readRuntimeFileRange } from './runtime-file-range-client'
import {
  fsReadFileChunk,
  installRuntimeFileClientEnvironment
} from '../runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()
const localArgs = {
  target: { kind: 'local' as const },
  filePath: '/repo/large.csv',
  relativePath: 'large.csv',
  worktreeId: 'folder:workspace'
}

describe('CSV range routing', () => {
  it('rejects invalid requests and corrupt or stalled responses', async () => {
    await expect(readRuntimeFileRange(localArgs, -1, 3)).rejects.toThrow('position')
    await expect(readRuntimeFileRange(localArgs, 0, 256 * 1024 + 1)).rejects.toThrow('limit')
    for (const { result, length } of [
      { result: { contentBase64: '', bytesRead: 0 }, length: 2 },
      { result: { contentBase64: 'YWJj', bytesRead: 2 }, length: 3 },
      { result: { contentBase64: 'YWJj', bytesRead: 3 }, length: 2 }
    ]) {
      fsReadFileChunk.mockResolvedValue(result)
      await expect(readRuntimeFileRange(localArgs, 0, length)).rejects.toThrow('invalid CSV chunk')
    }
  })
})
