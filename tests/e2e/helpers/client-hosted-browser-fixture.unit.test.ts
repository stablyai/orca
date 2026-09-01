import { describe, expect, it } from 'vitest'
import type { Page } from '@stablyai/playwright-test'
import {
  findMirroredBrowserPage,
  findPairedWorktreeId,
  readClientWebviewMarker
} from './client-hosted-browser-fixture'

function pageWhoseEvaluateThrows(message: string): Page {
  return {
    evaluate: async () => {
      throw new Error(message)
    }
  } as unknown as Page
}

describe('client-hosted restart evaluate polling', () => {
  it('treats a destroyed renderer context as a pending poll miss', async () => {
    const page = pageWhoseEvaluateThrows(
      'Execution context was destroyed, most likely because of a navigation.'
    )

    await expect(findPairedWorktreeId(page, '/repo')).resolves.toBeNull()
    await expect(findMirroredBrowserPage(page, 'wt-1', 'http://127.0.0.1/')).resolves.toBeNull()
    await expect(
      readClientWebviewMarker(page, { urlPrefix: 'http://127.0.0.1/', remotePageId: 'page-1' })
    ).resolves.toBeNull()
  })

  it('does not hide unrelated evaluate failures', async () => {
    const page = pageWhoseEvaluateThrows('fetchWorktrees failed')

    await expect(findPairedWorktreeId(page, '/repo')).rejects.toThrow('fetchWorktrees failed')
    await expect(findMirroredBrowserPage(page, 'wt-1', 'http://127.0.0.1/')).rejects.toThrow(
      'fetchWorktrees failed'
    )
    await expect(
      readClientWebviewMarker(page, { urlPrefix: 'http://127.0.0.1/', remotePageId: 'page-1' })
    ).rejects.toThrow('fetchWorktrees failed')
  })
})
