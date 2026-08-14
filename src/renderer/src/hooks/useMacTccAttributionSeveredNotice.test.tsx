// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { MacosTccPromptNoticeHost } from './MacosTccPromptNoticeHost'

const macTccAttribution = vi.hoisted(() =>
  vi.fn(async (): Promise<{ health: 'intact' | 'severed' | 'unknown' }> => ({ health: 'intact' }))
)
const openSettingsPage = vi.hoisted(() => vi.fn())
const openSettingsTarget = vi.hoisted(() => vi.fn())
const setSettingsSearchQuery = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ value: 'darwin' as NodeJS.Platform }))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    dismiss: vi.fn()
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
    platform.value = 'darwin'
    vi.mocked(toast.warning).mockReset()
    vi.mocked(toast.dismiss).mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: {
          get: () => ({ platform: platform.value })
        },
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
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalled()
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('does not probe on non-macOS focus', async () => {
    platform.value = 'win32'
    render(<MacosTccPromptNoticeHost />)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(macTccAttribution).not.toHaveBeenCalled()
  })

  it('toasts Manage Sessions remedy once when attribution is severed', async () => {
    macTccAttribution.mockResolvedValue({ health: 'severed' })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    const call = vi.mocked(toast.warning).mock.calls[0]
    const title = String(call?.[0] ?? '')
    const options = call?.[1] as
      | { description?: string; action?: { onClick?: () => void } }
      | undefined
    expect(title).toMatch(/macOS permissions may not reach Orca terminals/i)
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
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    rerender(<MacosTccPromptNoticeHost />)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
  })

  it('dismisses the warning after attribution recovers', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'severed' })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    macTccAttribution.mockResolvedValue({ health: 'intact' })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
      expect(toast.dismiss).toHaveBeenCalledWith('mac-tcc-attribution-severed')
    })
  })

  it('coalesces overlapping mount/focus checks into one IPC call and one toast', async () => {
    let resolveHealth!: (value: { health: 'severed' }) => void
    const pending = new Promise<{ health: 'severed' }>((resolve) => {
      resolveHealth = resolve
    })
    macTccAttribution.mockImplementation(() => pending)

    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(1)
    })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(macTccAttribution).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()

    await act(async () => {
      resolveHealth({ health: 'severed' })
      await pending
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(1)
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
  })

  it('clears the in-flight guard on rejection so a later focus can retry', async () => {
    macTccAttribution
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({ health: 'severed' })

    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(1)
    })
    expect(toast.warning).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
  })
})
