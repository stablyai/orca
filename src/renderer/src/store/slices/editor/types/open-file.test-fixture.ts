import type { OpenFile } from './open-file'

export function makeOpenFile(
  overrides: Partial<OpenFile> & { id: string; worktreeId: string }
): OpenFile {
  return {
    filePath: overrides.id,
    relativePath: 'file.ts',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}
