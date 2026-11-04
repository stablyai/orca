// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownPreviewLinkContext } from './markdown-preview-link-actions'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/link-source-local-open-owner', () => ({
  getLinkSourceLocalOpenOwner: () => ({ kind: 'local' })
}))
vi.mock('@/lib/local-path-open-guard', () => ({
  isLocalPathOpenBlocked: () => false,
  showLocalPathOpenBlockedToast: vi.fn()
}))

import { handleMarkdownPreviewSystemLinkClick } from './markdown-preview-system-link-action'

const pathExists = vi.fn(async (_path: string, _options?: { wakeWslDistro?: boolean }) => true)
const openFileUri = vi.fn(async () => undefined)

beforeEach(() => {
  pathExists.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { shell: { pathExists, openFileUri } }
  })
})

describe('Markdown preview system-open click (E9)', () => {
  it('checks the linked document as a user act that may start its stopped WSL distro', async () => {
    const context: Partial<MarkdownPreviewLinkContext> = {
      isMac: true,
      sourceOwner: { kind: 'local' },
      sourceRoutingWorktreeId: 'wt-1',
      worktreeRoot: '/repo'
    }
    const handled = handleMarkdownPreviewSystemLinkClick({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the modifier keys.
      event: {
        shiftKey: true,
        metaKey: true,
        ctrlKey: false
      } as React.MouseEvent<HTMLAnchorElement>,
      href: 'child.md',
      filePath: '/repo/docs/README.md',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the system-open path reads only the fields set above.
      context: context as MarkdownPreviewLinkContext
    })

    expect(handled).toBe(true)
    expect(pathExists).toHaveBeenCalledWith('/repo/docs/child.md', { wakeWslDistro: true })
    await vi.waitFor(() => expect(openFileUri).toHaveBeenCalled())
  })
})
