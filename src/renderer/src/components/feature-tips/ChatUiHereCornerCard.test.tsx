// @vitest-environment happy-dom

import { act, Profiler, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { ChatUiLaunchTipCohort } from '../../../../shared/telemetry-settings-types'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { ChatUiHereCornerCard } from './ChatUiHereCornerCard'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }))

class LinkVisibilityObserver implements IntersectionObserver {
  static current: LinkVisibilityObserver | undefined
  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0.5]
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()
  readonly takeRecords = (): IntersectionObserverEntry[] => []

  constructor(private readonly callback: IntersectionObserverCallback) {
    LinkVisibilityObserver.current = this
  }

  emit(target: Element, intersectionRatio: number): void {
    const bounds = new DOMRect()
    this.callback(
      [
        {
          target,
          isIntersecting: intersectionRatio > 0,
          intersectionRatio,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
          time: 0
        }
      ],
      this
    )
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const updateSettingsOrThrow = vi.fn()
const onClose = vi.fn()
const onCardRender = vi.fn()
const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()

beforeEach(() => {
  LinkVisibilityObserver.current = undefined
  vi.stubGlobal('IntersectionObserver', LinkVisibilityObserver)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ agentDefaultSurface: 'terminal' }),
    updateSettingsOrThrow,
    openSettingsTarget,
    openSettingsPage
  })
  updateSettingsOrThrow.mockReset().mockResolvedValue(undefined)
  onClose.mockReset()
  onCardRender.mockReset()
  openSettingsTarget.mockReset()
  openSettingsPage.mockReset()
  vi.mocked(toast.error).mockReset()
  vi.mocked(track).mockReset()
  vi.spyOn(Math, 'random').mockReturnValue(0.4)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  renderCard()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderCard(cohort?: ChatUiLaunchTipCohort, intersectionRatio = 1): void {
  const settings = createGlobalSettingsFixture({ agentDefaultSurface: 'terminal' })
  act(() =>
    useAppStore.setState({
      settings: {
        ...settings,
        telemetry: {
          optedIn: settings.telemetry?.optedIn ?? true,
          installId: settings.telemetry?.installId ?? 'install',
          existedBeforeTelemetryRelease: settings.telemetry?.existedBeforeTelemetryRelease ?? true,
          ...settings.telemetry,
          chatUiLaunchTipCohort: cohort
        }
      }
    })
  )
  act(() =>
    root.render(
      <StrictMode>
        <Profiler id="chat-ui-corner-card" onRender={onCardRender}>
          <ChatUiHereCornerCard onClose={onClose} />
        </Profiler>
      </StrictMode>
    )
  )
  const link = Array.from(container.querySelectorAll('button')).find(
    (entry) => entry.textContent === 'Live switching available'
  )
  if (link) {
    act(() => LinkVisibilityObserver.current?.emit(link, intersectionRatio))
  }
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (entry) => entry.textContent === label
  )
  if (!found) {
    throw new Error(`Missing button: ${label}`)
  }
  return found
}

describe('Chat UI corner card', () => {
  it.each(['treatment', 'treatment-swapped-buttons'] as const)(
    'turns on Chat UI, records the conversion and closes in %s',
    async (cohort) => {
      renderCard(cohort)
      await act(async () => button('Use Chat UI').click())
      expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({ agentDefaultSurface: 'chat' })
      expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_action', {
        variant: 'chat_ui_off',
        action: 'use_chat_ui'
      })
      expect(track).toHaveBeenCalledWith('agent_default_surface_changed', {
        from_mode: 'terminal',
        to_mode: 'chat',
        source: 'launch_card',
        launch_tip_shown: true
      })
      expect(onClose).toHaveBeenCalledOnce()
    }
  )

  it('swaps button order and emphasis only in the swapped-buttons arm', () => {
    const actionLabels = (): (string | null)[] =>
      Array.from(container.querySelectorAll('button'))
        .filter((entry) => ['Stay in terminal', 'Use Chat UI'].includes(entry.textContent ?? ''))
        .map((entry) => entry.textContent)

    expect(actionLabels()).toEqual(['Stay in terminal', 'Use Chat UI'])
    expect(button('Use Chat UI').dataset.variant).toBe('default')
    expect(button('Stay in terminal').dataset.variant).toBe('ghost')
    renderCard('treatment-live-switch')
    expect(actionLabels()).toEqual(['Stay in terminal', 'Use Chat UI'])
    expect(button('Use Chat UI').dataset.variant).toBe('default')
    expect(button('Stay in terminal').dataset.variant).toBe('ghost')
    renderCard('treatment-swapped-buttons')
    expect(actionLabels()).toEqual(['Use Chat UI', 'Stay in terminal'])
    expect(button('Use Chat UI').dataset.variant).toBe('ghost')
    expect(button('Stay in terminal').dataset.variant).toBe('default')
    expect(container.textContent).not.toContain('Live switching available')
  })

  it('keeps the card open with a retry when the save fails', async () => {
    updateSettingsOrThrow.mockRejectedValueOnce(new Error('disk unavailable'))
    await act(async () => button('Use Chat UI').click())
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Could not turn on Chat UI. Choose Chat in Settings → Agents.'
    )
    expect(track).not.toHaveBeenCalledWith(
      'chat_ui_feature_tip_action',
      expect.objectContaining({ action: 'use_chat_ui' })
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(button('Use Chat UI').disabled).toBe(false)
    await act(async () => button('Use Chat UI').click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each(['treatment', 'treatment-swapped-buttons'] as const)(
    'leaves the default alone when staying in the terminal in %s',
    (cohort) => {
      renderCard(cohort)
      act(() => button('Stay in terminal').click())
      expect(updateSettingsOrThrow).not.toHaveBeenCalled()
      expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_action', {
        variant: 'chat_ui_off',
        action: 'stay_in_terminal'
      })
      expect(onClose).toHaveBeenCalledOnce()
    }
  )

  it('opens Agents settings from the copy link', () => {
    const settingsLink = container.querySelector<HTMLButtonElement>('button.inline')
    act(() => settingsLink?.click())
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'agents',
      repoId: null,
      hostScope: { kind: 'local' },
      sectionId: 'agents-default-surface'
    })
    expect(openSettingsPage).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('records live-switching exposure once when the link appears, separately from opening it', () => {
    renderCard('treatment')
    expect(track).not.toHaveBeenCalledWith(
      'chat_ui_feature_tip_action',
      expect.objectContaining({ action: 'live_switching_shown' })
    )

    renderCard('treatment-live-switch')
    expect(button('Live switching available')).toBeDefined()
    renderCard('treatment-live-switch')
    expect(track).toHaveBeenCalledExactlyOnceWith('chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'live_switching_shown'
    })

    act(() => button('Live switching available').click())
    expect(track).toHaveBeenNthCalledWith(2, 'chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'open_live_switching'
    })
  })

  it('waits for a visible document and an in-view link, then releases observation', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    renderCard('treatment-live-switch')
    expect(track).not.toHaveBeenCalled()
    const observer = LinkVisibilityObserver.current
    expect(observer).toBeDefined()
    act(() => observer?.emit(button('Live switching available'), 0.25))
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(track).not.toHaveBeenCalled()

    act(() => observer?.emit(button('Live switching available'), 0.5))
    expect(track).toHaveBeenCalledExactlyOnceWith('chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'live_switching_shown'
    })
    expect(observer?.disconnect).toHaveBeenCalledOnce()
    act(() => {
      observer?.emit(button('Live switching available'), 1)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(track).toHaveBeenCalledOnce()
  })

  it('observes exposure without causing a render or synchronous layout measurement', () => {
    renderCard('treatment-live-switch', 0)
    const link = button('Live switching available')
    const measure = vi.spyOn(link, 'getBoundingClientRect')
    const rendersBeforeExposure = onCardRender.mock.calls.length
    act(() => {
      LinkVisibilityObserver.current?.emit(link, 0.25)
      LinkVisibilityObserver.current?.emit(link, 0.5)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(track).toHaveBeenCalledOnce()
    expect(onCardRender).toHaveBeenCalledTimes(rendersBeforeExposure)
    expect(measure).not.toHaveBeenCalled()
  })

  it('records an in-view link when the document becomes visible', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    renderCard('treatment-live-switch')
    expect(track).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(track).toHaveBeenCalledExactlyOnceWith('chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'live_switching_shown'
    })
  })

  it('releases pending observation on unmount without recording an exposure', () => {
    renderCard('treatment-live-switch', 0)
    const link = button('Live switching available')
    const observer = LinkVisibilityObserver.current
    act(() => root.render(null))
    expect(observer?.disconnect).toHaveBeenCalledOnce()
    act(() => {
      observer?.emit(link, 1)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(track).not.toHaveBeenCalled()
  })

  it('offers the live-switching demo only in the live-switch arm', () => {
    expect(container.textContent).not.toContain('Live switching available')

    renderCard('treatment-live-switch')
    const line = button('Live switching available')
    act(() => line.click())

    expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'open_live_switching'
    })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Live switching')
    expect(dialog?.textContent).toContain('Claude Code')
    expect(dialog?.textContent).toContain('Continue in Chat UI')
  })

  it.each(['Got it', 'Close', 'Escape'])(
    'returns focus to the live-switching opener after closing with %s',
    async (dismissal) => {
      renderCard('treatment-live-switch')
      const opener = button('Live switching available')
      act(() => {
        opener.focus()
        opener.click()
      })
      const dialog = document.querySelector('[role="dialog"]')
      expect(dialog?.contains(document.activeElement)).toBe(true)

      await act(async () => {
        if (dismissal === 'Escape') {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
          )
        } else {
          const closeButton = Array.from(dialog?.querySelectorAll('button') ?? []).find(
            (entry) => entry.textContent === dismissal
          )
          expect(closeButton).toBeDefined()
          closeButton?.click()
        }
      })

      await vi.waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.activeElement).toBe(opener)
      })
    }
  )
})
