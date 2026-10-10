// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { MacosTccPromptNoticeHost } from './MacosTccPromptNoticeHost'
import {
  useMacFolderAccessFixStore,
  type FolderAccessNoticePhase
} from '@/store/mac-folder-access-fix'

type FolderAccessMismatch = {
  daemonScope: string
  cwdClass: string
  freshDaemonAccess: string
} | null
type AttributionResult = {
  health: 'intact' | 'severed' | 'unknown'
  folderAccessMismatch: FolderAccessMismatch
}

const macTccAttribution = vi.hoisted(() =>
  vi.fn(async (): Promise<AttributionResult> => ({ health: 'intact', folderAccessMismatch: null }))
)
const trackTelemetry = vi.hoisted(() => vi.fn())
const openSettingsPage = vi.hoisted(() => vi.fn())
const openSettingsTarget = vi.hoisted(() => vi.fn())
const setSettingsSearchQuery = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ value: 'darwin' as NodeJS.Platform }))

// Sonner routes a programmatic dismissal through the toast's own onDismiss, which is the only
// reason the hook guards that callback at all.
const onDismissById = vi.hoisted(() => new Map<string, () => void>())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn((_title: string, options?: { id?: string; onDismiss?: () => void }) => {
      if (options?.id !== undefined && options.onDismiss) {
        onDismissById.set(options.id, options.onDismiss)
      }
    }),
    dismiss: vi.fn((id?: string) => {
      if (id !== undefined) {
        onDismissById.get(id)?.()
      }
    })
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
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => options?.[name] ?? match)
}))

vi.mock('@/lib/telemetry', () => ({ track: trackTelemetry }))

vi.mock('./useMacosTccPromptNotice', () => ({
  useMacosTccPromptNotice: vi.fn()
}))

describe('useMacTccAttributionSeveredNotice', () => {
  beforeEach(() => {
    macTccAttribution.mockReset()
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: null })
    trackTelemetry.mockReset()
    openSettingsPage.mockReset()
    openSettingsTarget.mockReset()
    setSettingsSearchQuery.mockReset()
    platform.value = 'darwin'
    vi.mocked(toast.warning).mockClear()
    vi.mocked(toast.dismiss).mockClear()
    onDismissById.clear()
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
    macTccAttribution.mockResolvedValue({ health: 'severed', folderAccessMismatch: null })
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
    macTccAttribution.mockResolvedValue({ health: 'severed', folderAccessMismatch: null })
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
    macTccAttribution.mockResolvedValueOnce({ health: 'severed', folderAccessMismatch: null })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: null })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
      expect(toast.dismiss).toHaveBeenCalledWith('mac-tcc-attribution-severed')
    })
  })

  it('coalesces overlapping mount/focus checks into one IPC call and one toast', async () => {
    let resolveHealth!: (value: AttributionResult) => void
    const pending = new Promise<AttributionResult>((resolve) => {
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
      resolveHealth({ health: 'severed', folderAccessMismatch: null })
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
      .mockResolvedValueOnce({ health: 'severed', folderAccessMismatch: null })

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

describe('useMacTccAttributionSeveredNotice folder-access notice', () => {
  const SCOPE_A = {
    daemonScope: 'aaaa111122223333',
    cwdClass: 'documents',
    freshDaemonAccess: 'allowed'
  }
  const SCOPE_B = {
    daemonScope: 'bbbb444455556666',
    cwdClass: 'desktop',
    freshDaemonAccess: 'denied'
  }

  type ToastOptions = {
    id?: string
    description?: string
    duration?: number
    action?: { label?: string; onClick?: (event: { preventDefault: () => void }) => void }
    cancel?: { label?: string; onClick?: () => void }
    onDismiss?: () => void
  }

  function dismissedEvents(): Record<string, unknown>[] {
    return trackTelemetry.mock.calls
      .filter(
        ([name, props]) => name === 'daemon_folder_access_notice' && props.action === 'dismissed'
      )
      .map(([, props]) => props)
  }

  function noticePhase(daemonScope: string): FolderAccessNoticePhase | undefined {
    return useMacFolderAccessFixStore.getState().noticePhaseByScope.get(daemonScope)
  }

  function shownEvents(): Record<string, unknown>[] {
    return trackTelemetry.mock.calls
      .filter(([name, props]) => name === 'daemon_folder_access_notice' && props.action === 'shown')
      .map(([, props]) => props)
  }

  /** Sonner hands the action a real event and deletes the toast unless the handler prevents it. */
  function clickFix(index = 0): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = { preventDefault: vi.fn() }
    act(() => {
      folderNoticeCalls()[index].options.action?.onClick?.(event)
    })
    return event
  }

  function folderNoticeCalls(): { title: string; options: ToastOptions }[] {
    return vi
      .mocked(toast.warning)
      .mock.calls.map((call) => ({
        title: String(call[0] ?? ''),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook is the only caller and always passes this options object.
        options: (call[1] ?? {}) as ToastOptions
      }))
      .filter(({ options }) => options.id === 'mac-daemon-folder-access-mismatch')
  }

  beforeEach(() => {
    macTccAttribution.mockReset()
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: null })
    trackTelemetry.mockReset()
    openSettingsPage.mockReset()
    openSettingsTarget.mockReset()
    setSettingsSearchQuery.mockReset()
    platform.value = 'darwin'
    vi.mocked(toast.warning).mockClear()
    vi.mocked(toast.dismiss).mockClear()
    useMacFolderAccessFixStore.setState({
      mismatch: null,
      openScope: null,
      noticePhaseByScope: new Map<string, FolderAccessNoticePhase>()
    })
    onDismissById.clear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: { get: () => ({ platform: platform.value }) },
        pty: { management: { macTccAttribution } }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('does not toast when there is no mismatch', async () => {
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalled()
    })
    expect(folderNoticeCalls()).toHaveLength(0)
  })

  it('names the denied folder and the cost, and leaves the steps to the dialog', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    const notice = folderNoticeCalls()[0]
    expect(notice.title).toMatch(/Terminals can’t read your Documents folder/i)
    // The dialog carries the steps; the toast says what is blocked and what that costs.
    expect(notice.options.description).toMatch(/may fail until it’s fixed/)
    expect(notice.options.description).not.toMatch(/Manage Sessions|System Settings/)
    expect(notice.options.duration).toBe(Infinity)
    expect(notice.options.action?.label).toBe('Fix')
    expect(notice.options.cancel).toBeUndefined()
  })

  it('opens the fix dialog rather than Manage Sessions', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    clickFix()

    expect(useMacFolderAccessFixStore.getState().openScope).toBe(SCOPE_A.daemonScope)
    expect(useMacFolderAccessFixStore.getState().mismatch).toEqual(SCOPE_A)
    expect(openSettingsPage).not.toHaveBeenCalled()
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'fix_opened',
      cwd_class: 'documents'
    })
  })

  it('carries a later poll’s verdict into the open dialog', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    clickFix()
    macTccAttribution.mockResolvedValue({
      health: 'intact',
      folderAccessMismatch: { ...SCOPE_A, freshDaemonAccess: 'denied' }
    })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(useMacFolderAccessFixStore.getState().mismatch?.freshDaemonAccess).toBe('denied')
    })
  })

  // Sonner deletes a toast after its action button runs unless the handler prevents the event, and
  // it does that silently — no onDismiss — so the scope would stay latched with nothing on screen.
  it('keeps the toast up when the user opens the dialog', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    const event = clickFix()

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(noticePhase(SCOPE_A.daemonScope)).toBe('visible')
    // The toast sonner kept is the one still on screen, so a later poll must not raise a second.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
    })
    expect(folderNoticeCalls()).toHaveLength(1)
    expect(dismissedEvents()).toHaveLength(0)
  })

  // The open remedy belongs to one scope, so evidence that moves closes it rather than retargeting
  // the title, the checklist, and the reset onto a folder the user never asked about.
  it('closes the open dialog when the evidence moves to another scope', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    clickFix()
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_B })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(useMacFolderAccessFixStore.getState().mismatch).toEqual(SCOPE_B)
    })

    // Ended, not parked: the scope coming back later must not pop the dialog on its own.
    expect(useMacFolderAccessFixStore.getState().openScope).toBeNull()
  })

  // The toast outlives the poll that raised it, and a restart offered against a stale `unknown`
  // would kill every terminal for a daemon that is provably denied.
  it('opens the dialog on the latest verdict, not the one that raised the toast', async () => {
    const unanswered = { ...SCOPE_A, freshDaemonAccess: 'unknown' }
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: unanswered })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    const denied = { ...SCOPE_A, freshDaemonAccess: 'denied' }
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: denied })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
    })

    clickFix()

    expect(folderNoticeCalls()).toHaveLength(1)
    expect(useMacFolderAccessFixStore.getState().mismatch).toEqual(denied)
  })

  it('substitutes the folder word for each protected class', async () => {
    for (const [cwdClass, expected] of [
      ['desktop', 'Desktop folder'],
      ['downloads', 'Downloads folder'],
      ['other-home', 'workspace folder'],
      ['outside-home', 'workspace folder']
    ]) {
      vi.mocked(toast.warning).mockClear()
      macTccAttribution.mockResolvedValue({
        health: 'intact',
        folderAccessMismatch: {
          daemonScope: `scope-${cwdClass}`,
          cwdClass,
          freshDaemonAccess: 'allowed'
        }
      })
      render(<MacosTccPromptNoticeHost />)
      await waitFor(() => {
        expect(folderNoticeCalls()).toHaveLength(1)
      })
      expect(folderNoticeCalls()[0].title).toContain(expected)
      cleanup()
    }
  })

  it('shows once per daemon scope, not once per poll', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
    })
    expect(folderNoticeCalls()).toHaveLength(1)
    expect(shownEvents()).toHaveLength(1)
  })

  // The notice is shown by the renderer, so the renderer is what can count it.
  it('counts the notice as shown when it raises one, and not when it withholds one', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    expect(shownEvents()).toEqual([{ action: 'shown', cwd_class: 'documents' }])
  })

  it('never re-shows a scope the user dismissed this session', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    folderNoticeCalls()[0].options.onDismiss?.()
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'dismissed',
      cwd_class: 'documents'
    })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
    })
    expect(folderNoticeCalls()).toHaveLength(1)
  })

  // The restart remedy: a replacement daemon mints a new identity, so the poll goes quiet.
  it('dismisses the notice once the poll stops reporting a mismatch', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: null })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(toast.dismiss).toHaveBeenCalledWith('mac-daemon-folder-access-mismatch')
    })
  })

  // A reconnect blip reports no daemon and takes the toast down, so the same notice comes back.
  // Counting that raise would inflate the denominator the affected-user rate is read against.
  it('re-shows the same daemon after a poll that briefly reported nothing, counting it once', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: null })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(toast.dismiss).toHaveBeenCalledWith('mac-daemon-folder-access-mismatch')
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(2)
    })
    expect(shownEvents()).toHaveLength(1)
    expect(noticePhase(SCOPE_A.daemonScope)).toBe('visible')
  })

  it('shows again when a replacement daemon is denied too', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_B })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(2)
    })
    expect(folderNoticeCalls()[1].title).toContain('Desktop folder')
    // A second scope is a second affected notice, so it does count.
    expect(shownEvents()).toHaveLength(2)
  })

  // A second scope — a replacement daemon, or one daemon denied a second folder class — reuses the
  // toast id, so the replaced toast's onDismiss may still fire. It must latch neither scope.
  it('does not read a replaced toast’s dismissal as the user’s', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    const replaced = folderNoticeCalls()[0].options.onDismiss
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_B })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(2)
    })

    act(() => {
      replaced?.()
    })

    expect(dismissedEvents()).toHaveLength(0)
    expect(noticePhase(SCOPE_A.daemonScope)).toBe('retired')
    expect(noticePhase(SCOPE_B.daemonScope)).toBe('visible')
  })

  // A takedown the user did not ask for reaches the same callback, and must not read as their X.
  it('counts only the user’s own close as a dismissal', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: null })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(toast.dismiss).toHaveBeenCalledWith('mac-daemon-folder-access-mismatch')
    })
    expect(dismissedEvents()).toHaveLength(0)

    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(2)
    })
    act(() => {
      folderNoticeCalls()[1].options.onDismiss?.()
    })

    expect(dismissedEvents()).toHaveLength(1)
  })

  it('raises both notices when attribution is severed and a folder is denied', async () => {
    macTccAttribution.mockResolvedValue({ health: 'severed', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(2)
    })
    expect(folderNoticeCalls()).toHaveLength(1)
  })
})
