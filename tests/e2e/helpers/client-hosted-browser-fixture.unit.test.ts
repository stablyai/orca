import { describe, expect, it } from 'vitest'
import type { Page } from '@stablyai/playwright-test'
import type { PairedElectronClient } from './paired-electron-client'
import {
  findMirroredBrowserPage,
  findPairedWorktreeId,
  readClientWebviewMarker
} from './client-hosted-browser-fixture'
import { readRelaunchedRuntimeId } from './client-hosted-runtime-relaunch'

function pageWhoseEvaluateThrows(message: string): Page {
  return {
    evaluate: async () => {
      throw new Error(message)
    }
  } as unknown as Page
}

function clientWhoseEvaluateThrows(message: string): PairedElectronClient {
  return {
    environmentId: 'env-1',
    page: pageWhoseEvaluateThrows(message)
  } as unknown as PairedElectronClient
}

function clientWhoseEvaluateReturns(value: string | null): PairedElectronClient {
  return {
    environmentId: 'env-1',
    page: {
      evaluate: async () => value
    }
  } as unknown as PairedElectronClient
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

describe('client-hosted relaunch wait', () => {
  it('treats a destroyed renderer context as a pending relaunch miss', async () => {
    const pending = await readRelaunchedRuntimeId(
      clientWhoseEvaluateThrows(
        'Execution context was destroyed, most likely because of a navigation.'
      ),
      'runtime-old'
    )
    expect(pending).toBeNull()
  })

  it('does not hide unrelated evaluate failures', async () => {
    await expect(
      readRelaunchedRuntimeId(clientWhoseEvaluateThrows('fetchWorktrees failed'), 'runtime-old')
    ).rejects.toThrow('fetchWorktrees failed')
  })

  it('succeeds only with a live runtime id that is not the pre-restart process', async () => {
    await expect(
      readRelaunchedRuntimeId(clientWhoseEvaluateReturns('runtime-old'), 'runtime-old')
    ).resolves.toBeNull()
    await expect(
      readRelaunchedRuntimeId(clientWhoseEvaluateReturns(null), 'runtime-old')
    ).resolves.toBeNull()
    await expect(
      readRelaunchedRuntimeId(clientWhoseEvaluateReturns('runtime-new'), 'runtime-old')
    ).resolves.toBe('runtime-new')
  })
})
