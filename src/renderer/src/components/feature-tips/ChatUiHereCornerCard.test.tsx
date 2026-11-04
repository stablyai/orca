// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
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

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const updateSettingsOrThrow = vi.fn()
const onClose = vi.fn()
const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ agentDefaultSurface: 'terminal' }),
    updateSettingsOrThrow,
    openSettingsTarget,
    openSettingsPage
  })
  updateSettingsOrThrow.mockReset().mockResolvedValue(undefined)
  onClose.mockReset()
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
})

function renderCard(cohort?: ChatUiLaunchTipCohort, buttonEmphasis?: 'normal' | 'swapped'): void {
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
          chatUiLaunchTipCohort: cohort,
          chatUiLaunchTipButtonEmphasis: buttonEmphasis
        }
      }
    })
  )
  act(() =>
    root.render(
      <StrictMode>
        <ChatUiHereCornerCard onClose={onClose} />
      </StrictMode>
    )
  )
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
  it.each([
    'treatment',
    'treatment-center',
    'treatment-live-switch',
    'treatment-swapped-buttons'
  ] as const)('turns on Chat UI, records the conversion and closes in %s', async (cohort) => {
    renderCard(cohort)
    await act(async () => button('Use Chat UI').click())
    expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({ agentDefaultSurface: 'chat' })
    expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_action', {
      launch_tip_experiment_version: 'corner-card-v3',
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
  })

  it('preserves independent button emphasis and legacy swapped-button assignments', () => {
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
    renderCard('treatment', 'swapped')
    expect(actionLabels()).toEqual(['Use Chat UI', 'Stay in terminal'])
    expect(button('Stay in terminal').dataset.variant).toBe('default')
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

  it.each([
    'treatment',
    'treatment-center',
    'treatment-live-switch',
    'treatment-swapped-buttons'
  ] as const)('leaves the default alone when staying in the terminal in %s', (cohort) => {
    renderCard(cohort)
    act(() => button('Stay in terminal').click())
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_action', {
      launch_tip_experiment_version: 'corner-card-v3',
      variant: 'chat_ui_off',
      action: 'stay_in_terminal'
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

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

  it.each(['treatment', 'treatment-center', 'treatment-live-switch'] as const)(
    'shows the plain corner card for %s assignments',
    (cohort) => {
      renderCard(cohort)
      expect(container.querySelector('[role="complementary"]')).not.toBeNull()
      expect(container.textContent).not.toContain('Live switching available')
      expect(track).not.toHaveBeenCalled()
    }
  )
})
