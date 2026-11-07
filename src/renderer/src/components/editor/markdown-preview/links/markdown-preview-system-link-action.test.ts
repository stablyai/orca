import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))

import { markdownPreviewLinkEditorOpener } from './markdown-preview-system-link-action'

const root = process.platform === 'win32' ? 'C:\\repo' : '/repo'
const filePath = process.platform === 'win32' ? 'C:\\repo\\README.md' : '/repo/README.md'

function makeContext(sourceRoutingWorktreeId: string | null) {
  return {
    sourceOwner: { kind: 'local' } as const,
    sourceRoutingWorktreeId,
    resolvedSourceRuntimeEnvironmentId: null,
    worktreeRoot: root,
    activateMarkdownLink: vi.fn(async () => {})
  }
}

describe('markdownPreviewLinkEditorOpener', () => {
  it('opens the link through the same route as a plain click', () => {
    const context = makeContext('wt-1')

    markdownPreviewLinkEditorOpener('scripts/run.sh', filePath, context)?.()

    expect(context.activateMarkdownLink).toHaveBeenCalledWith('scripts/run.sh', {
      sourceFilePath: filePath,
      worktreeId: 'wt-1',
      worktreeRoot: root,
      runtimeEnvironmentId: null,
      sourceOwner: { kind: 'local' }
    })
  })

  it('has no editor route without a workspace', () => {
    expect(markdownPreviewLinkEditorOpener('run.sh', filePath, makeContext(null))).toBeNull()
  })
})
