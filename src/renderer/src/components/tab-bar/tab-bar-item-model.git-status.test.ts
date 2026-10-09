import { describe, expect, it } from 'vitest'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import { resolveEditorTabGitStatus } from './tab-bar-item-model'

const statusByRelativePath = new Map<string, GitFileStatus>([['index.html', 'modified']])

describe('resolveEditorTabGitStatus', () => {
  it('decorates a file tab from its workspace path', () => {
    expect(
      resolveEditorTabGitStatus({ mode: 'edit', relativePath: 'index.html' }, statusByRelativePath)
    ).toBe('modified')
  })

  it.each(['chat-visual', 'check-details'] as const)(
    'never decorates a %s tab whose title matches a changed file',
    (mode) => {
      expect(
        resolveEditorTabGitStatus({ mode, relativePath: 'index.html' }, statusByRelativePath)
      ).toBeNull()
    }
  )
})
