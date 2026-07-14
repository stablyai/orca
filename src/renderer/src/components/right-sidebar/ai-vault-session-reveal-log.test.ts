// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revealAiVaultSessionLog } from './ai-vault-session-reveal-log'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (msg: string) => toastError(msg) } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const openPath = vi.fn<(path: string) => Promise<void>>()
const openInFileManager = vi.fn<(path: string) => Promise<{ ok: boolean }>>()

beforeEach(() => {
  openPath.mockReset().mockResolvedValue(undefined)
  openInFileManager.mockReset().mockResolvedValue({ ok: true })
  toastError.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = { shell: { openPath, openInFileManager } }
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api teardown
  delete (window as any).api
})

describe('revealAiVaultSessionLog', () => {
  it('opens a real transcript path directly', async () => {
    await revealAiVaultSessionLog({ filePath: '/home/user/.claude/sessions/log.jsonl' })
    expect(openPath).toHaveBeenCalledWith('/home/user/.claude/sessions/log.jsonl')
    expect(openInFileManager).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('reveals the backing db for a synthetic web-chat path', async () => {
    await revealAiVaultSessionLog({ filePath: '/home/user/.orca/chats.db#chatgpt/conv_9' })
    expect(openInFileManager).toHaveBeenCalledWith('/home/user/.orca/chats.db')
    expect(openPath).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('toasts when revealing the backing db fails', async () => {
    openInFileManager.mockResolvedValue({ ok: false })
    await revealAiVaultSessionLog({ filePath: '/home/user/.opencode/db.sqlite#sess_1' })
    expect(openInFileManager).toHaveBeenCalledWith('/home/user/.opencode/db.sqlite')
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
