import type { ElectronApplication } from '@stablyai/playwright-test'
import { describe, expect, it, vi } from 'vitest'
import {
  hasCapturedGitStatusRetry,
  installGitStatusRetryBarrier,
  restoreGitStatusRetryHandler
} from './git-status-retry-barrier'

describe('Git status retry barrier', () => {
  it('holds the target interactive request and restores the real handler on cleanup', async () => {
    const original = vi.fn(async (_event: unknown, args: unknown) => args)
    const handlers = new Map([['git:status', original]])
    const app = {
      evaluate: (callback: (electron: unknown, arg?: unknown) => unknown, arg?: unknown) =>
        Promise.resolve(callback({ ipcMain: { _invokeHandlers: handlers } }, arg))
    } as unknown as ElectronApplication
    await installGitStatusRetryBarrier(app, 'target-repo')
    try {
      const handler = handlers.get('git:status')!
      const background = { worktreePath: 'target-repo', admissionTier: 'background' }
      const otherRepo = { worktreePath: 'another-repo', admissionTier: 'interactive' }
      await expect(handler({}, background)).resolves.toEqual(background)
      await expect(handler({}, otherRepo)).resolves.toEqual(otherRepo)
      expect(await hasCapturedGitStatusRetry(app)).toBe(false)

      const retry = { worktreePath: 'target-repo', admissionTier: 'interactive' }
      const event = {}
      const pending = handler(event, retry)
      expect(await hasCapturedGitStatusRetry(app)).toBe(true)
      expect(original).toHaveBeenCalledTimes(2)
      await restoreGitStatusRetryHandler(app)
      await expect(pending).resolves.toEqual(retry)
      expect(original).toHaveBeenLastCalledWith(event, retry)
      expect(handlers.get('git:status')).toBe(original)
    } finally {
      await restoreGitStatusRetryHandler(app)
    }
  })
})
