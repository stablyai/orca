// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTerminalRichInputPathInsertion } from './use-terminal-rich-input-path-insertion'

describe('useTerminalRichInputPathInsertion', () => {
  it('ignores file and image drops while a submission is in flight', () => {
    const appendImagePaths = vi.fn()
    const editor = { state: { selection: { from: 1 } } }
    const hook = renderHook(() =>
      useTerminalRichInputPathInsertion({
        editor: editor as never,
        agent: 'claude',
        resourceContext: {
          connectionId: null,
          runtimeEnvironmentId: null,
          worktreeId: 'worktree-1',
          worktreePath: '/repo'
        },
        targetShell: 'posix',
        sending: true,
        canAttachImages: true,
        appendImagePaths
      })
    )

    hook.result.current(['/tmp/file.ts', '/tmp/image.png'])

    expect(appendImagePaths).not.toHaveBeenCalled()
  })
})
