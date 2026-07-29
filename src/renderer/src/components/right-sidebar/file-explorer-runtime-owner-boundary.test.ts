import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('right sidebar file/git runtime ownership boundaries', () => {
  it.each([
    'src/renderer/src/components/right-sidebar/useFileExplorerTree.ts',
    'src/renderer/src/components/right-sidebar/useFileExplorerImport.ts',
    'src/renderer/src/components/right-sidebar/useFileExplorerInlineInput.ts',
    'src/renderer/src/components/right-sidebar/useFileExplorerDragDrop.ts',
    'src/renderer/src/components/right-sidebar/useFileDuplicate.ts',
    'src/renderer/src/components/right-sidebar/useFileDeletion.ts',
    'src/renderer/src/components/right-sidebar/use-file-explorer-ignored-paths.ts',
    'src/renderer/src/components/right-sidebar/useGitStatusPolling.ts',
    'src/renderer/src/components/right-sidebar/useFileSearchRunner.ts',
    'src/renderer/src/components/quick-open-file-list.ts'
  ])('%s routes file/git requests by the selected worktree owner', (path) => {
    const text = source(path)

    expect(text).toMatch(
      /getRightSidebarWorktreeRuntimeSettings|getSettingsForWorktreeRuntimeOwner|getFileExplorerOperationOwner|getFileExplorerOperationRoute|captureFileExplorerOperationGuard|requireFileExplorerOperationRoute|requireMatchingFileExplorerOperationRoute/
    )
    expect(text).not.toContain('settings: useAppStore.getState().settings')
    expect(text).not.toContain('const settings = useAppStore.getState().settings')
  })

  it('derives owner settings through the shared worktree runtime owner helper', () => {
    const text = source('src/renderer/src/components/right-sidebar/file-explorer-runtime-owner.ts')

    expect(text).toContain('getSettingsForWorktreeRuntimeOwner')
    expect(text).toContain('useAppStore.getState()')
  })
})
