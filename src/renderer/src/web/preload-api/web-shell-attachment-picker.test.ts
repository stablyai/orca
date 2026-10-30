// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { takeBrowserAttachmentFile } from '@/lib/browser-attachment-files'
import { createShellApi } from './web-shell-api'

vi.mock('./web-runtime-worktree-catalog', () => ({ resolveRuntimeFilePath: vi.fn() }))

function chooseOnClick(files: File[] | null): void {
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    if (files === null) {
      this.dispatchEvent(new Event('cancel'))
      return
    }
    Object.defineProperty(this, 'files', { value: files })
    this.dispatchEvent(new Event('change'))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('web chat attachment picker', () => {
  it('opens the browser file picker and returns tokens the chat upload can read', async () => {
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.png')]
    chooseOnClick(files)

    const tokens = await createShellApi().pickAttachments!()

    expect(tokens).toHaveLength(2)
    expect(tokens.map((token) => takeBrowserAttachmentFile(token))).toEqual(files)
  })

  it('returns nothing when the picker is cancelled', async () => {
    chooseOnClick(null)
    await expect(createShellApi().pickAttachments!()).resolves.toEqual([])
  })
})
