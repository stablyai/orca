// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { toast } from 'sonner'
import { MacosTccPromptNoticeHost } from './MacosTccPromptNoticeHost'

const macTccAttribution = vi.hoisted(() =>
  vi.fn(async (): Promise<{ health: 'intact' | 'severed' | 'unknown' }> => ({ health: 'intact' }))
)
const openSettingsPage = vi.hoisted(() => vi.fn())
const openSettingsTarget = vi.hoisted(() => vi.fn())
const setSettingsSearchQuery = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn()
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: 'en',
      hasResourceBundle: () => true
    }
  })
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      openSettingsPage,
      openSettingsTarget,
      setSettingsSearchQuery,
      settings: { uiLanguage: 'en' }
    })
}))

vi.mock('@/store/plugin-language-packs', () => ({
  usePluginLanguagePackStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ packs: [], loaded: true })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./useMacosTccPromptNotice', () => ({
  useMacosTccPromptNotice: vi.fn()
}))

describe('useMacTccAttributionSeveredNotice', () => {
  beforeEach(() => {
    macTccAttribution.mockReset()
    macTccAttribution.mockResolvedValue({ health: 'intact' })
    openSettingsPage.mockReset()
    openSettingsTarget.mockReset()
    setSettingsSearchQuery.mockReset()
    vi.mocked(toast.warning).mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        pty: {
          management: {
            macTccAttribution
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('does not toast when attribution is intact', async () => {
    render(<MacosTccPromptNoticeHost />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(macTccAttribution).toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('toasts Manage Sessions remedy once when attribution is severed', async () => {
    macTccAttribution.mockResolvedValue({ health: 'severed' })
    render(<MacosTccPromptNoticeHost />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(toast.warning).toHaveBeenCalledTimes(1)
    const call = vi.mocked(toast.warning).mock.calls[0]
    const title = String(call?.[0] ?? '')
    const options = call?.[1] as
      | { description?: string; action?: { onClick?: () => void } }
      | undefined
    expect(title).toMatch(/Terminal permissions may be broken/i)
    expect(String(options?.description ?? '')).toMatch(/Manage Sessions/i)
    options?.action?.onClick?.()
    expect(setSettingsSearchQuery).toHaveBeenCalledWith('')
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'terminal',
      repoId: null,
      sectionId: 'terminal-manage-sessions'
    })
    expect(openSettingsPage).toHaveBeenCalled()
  })

  it('does not toast again after the first severed notice this session', async () => {
    macTccAttribution.mockResolvedValue({ health: 'severed' })
    const { rerender } = render(<MacosTccPromptNoticeHost />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(toast.warning).toHaveBeenCalledTimes(1)
    rerender(<MacosTccPromptNoticeHost />)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('coalesces overlapping mount/focus checks into one IPC call and one toast', async () => {
    let resolveHealth!: (value: { health: 'severed' }) => void
    const pending = new Promise<{ health: 'severed' }>((resolve) => {
      resolveHealth = resolve
    })
    macTccAttribution.mockImplementation(() => pending)

    render(<MacosTccPromptNoticeHost />)
    // Focus while the first check is still in flight — must not start a second IPC.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(macTccAttribution).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()

    await act(async () => {
      resolveHealth({ health: 'severed' })
      await pending
      await Promise.resolve()
    })
    expect(macTccAttribution).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('clears the in-flight guard on rejection so a later focus can retry', async () => {
    macTccAttribution
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({ health: 'severed' })

    render(<MacosTccPromptNoticeHost />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(toast.warning).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(macTccAttribution).toHaveBeenCalledTimes(2)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })
})
