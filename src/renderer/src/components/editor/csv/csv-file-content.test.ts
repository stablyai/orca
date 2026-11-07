import { describe, expect, it } from 'vitest'
import { readEditorCsvFileContent } from './csv-file-content'
import {
  fsStat,
  installRuntimeFileClientEnvironment
} from '@/runtime/files/runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()
const localArgs = {
  target: { kind: 'local' as const },
  filePath: '/repo/large.csv',
  relativePath: 'large.csv',
  worktreeId: 'folder:workspace'
}
const snapshot = { size: 100 * 1024 * 1024, isDirectory: false, mtime: 123 }

describe('CSV file admission', () => {
  it('provides a range preview for a large CSV', async () => {
    fsStat.mockResolvedValue(snapshot)
    expect(await readEditorCsvFileContent(localArgs)).toEqual({
      content: '',
      isBinary: false,
      csvPreview: { readArgs: localArgs, snapshot }
    })
  })
})
