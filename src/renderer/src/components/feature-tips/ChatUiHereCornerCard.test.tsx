// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { ChatUiHereCornerCard } from './ChatUiHereCornerCard'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

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
  container = document.createElement('div')
  root = createRoot(container)
  act(() => root.render(<ChatUiHereCornerCard onClose={onClose} />))
})

afterEach(() => {
  act(() => root.unmount())
})

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
  it('turns on Chat UI, records the conversion and closes', async () => {
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

  it('leaves the default alone when staying in the terminal', () => {
    act(() => button('Stay in terminal').click())
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_action', {
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
})
