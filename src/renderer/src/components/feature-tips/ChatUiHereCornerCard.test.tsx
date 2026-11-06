// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { ChatUiHereCornerCard } from './ChatUiHereCornerCard'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const updateSettingsOrThrow = vi.fn()
const onClose = vi.fn()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ agentDefaultSurface: 'terminal' }),
    updateSettingsOrThrow
  })
  updateSettingsOrThrow.mockReset().mockResolvedValue(undefined)
  onClose.mockReset()
  vi.mocked(toast.error).mockReset()
  vi.mocked(track).mockReset()
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

function renderCard(): void {
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
  it('keeps the card open with a retry when the save fails', async () => {
    updateSettingsOrThrow.mockRejectedValueOnce(new Error('disk unavailable'))
    await act(async () => button('Use Chat UI').click())
    expect(toast.error).toHaveBeenCalledOnce()
    expect(track).not.toHaveBeenCalledWith(
      'chat_ui_feature_tip_action',
      expect.objectContaining({ action: 'use_chat_ui' })
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(button('Use Chat UI').disabled).toBe(false)
    await act(async () => button('Use Chat UI').click())
    expect(onClose).not.toHaveBeenCalled()
    act(() => button('Open Settings').click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(useAppStore.getState().activeView).toBe('settings')
    expect(useAppStore.getState().settingsNavigationTarget).toEqual({
      pane: 'chat',
      repoId: null,
      sectionId: 'chat-launch-default'
    })
  })
})
