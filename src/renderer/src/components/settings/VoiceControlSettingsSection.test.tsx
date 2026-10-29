// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  getDefaultVoiceControlSettings,
  getDefaultVoiceSettings
} from '../../../../shared/constants'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { OPENAI_REALTIME_VOICES } from '../../../../shared/voice-control-types'
import { VoiceControlSettingsSection } from './VoiceControlSettingsSection'

const { useShortcutLabelMock } = vi.hoisted(() => ({ useShortcutLabelMock: vi.fn() }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: useShortcutLabelMock }))

useShortcutLabelMock.mockReturnValue('⌘⇧V')

afterEach(() => cleanup())

function renderSection(voiceSettings: VoiceSettings = getDefaultVoiceSettings()) {
  const onUpdateVoiceSettings = vi.fn()
  const user = userEvent.setup()
  render(
    <VoiceControlSettingsSection
      voiceSettings={voiceSettings}
      onUpdateVoiceSettings={onUpdateVoiceSettings}
    />
  )
  return { user, onUpdateVoiceSettings }
}

describe('VoiceControlSettingsSection', () => {
  it('renders the enable toggle, pickers, and cost note', () => {
    renderSection()

    expect(screen.getByRole('switch', { name: 'Enable Full Voice Control' })).not.toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Coordinator voice' })).toHaveTextContent('Marin')
    expect(screen.getByRole('combobox', { name: 'Agent updates' })).toHaveTextContent(
      'Relay updates without naming agents'
    )
    expect(screen.getByRole('combobox', { name: 'Max session length' })).toHaveTextContent(
      '30 minutes'
    )
    expect(screen.getByRole('combobox', { name: 'Speech speed' })).toHaveTextContent('1×')
    expect(screen.getByRole('combobox', { name: 'Suspend when quiet' })).toHaveTextContent(
      '5 minutes'
    )
    expect(screen.getByRole('switch', { name: 'Only stream when I speak' })).toBeChecked()
    expect(screen.getByText('Realtime audio is billed per minute of session time.')).toBeVisible()
  })

  it('shows the start/stop shortcut in the enable-row description', () => {
    renderSection()

    expect(
      screen.getByText(
        'Press ⌘⇧V to start or stop. Talk to your agents hands-free with an open mic.'
      )
    ).toBeVisible()
  })

  it('writes the enable toggle as a whole-object control merge', async () => {
    const { user, onUpdateVoiceSettings } = renderSection()

    await user.click(screen.getByRole('switch', { name: 'Enable Full Voice Control' }))

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      control: { ...getDefaultVoiceControlSettings(), enabled: true }
    })
  })

  it('lists every OpenAI realtime voice and merges the pick onto the control', async () => {
    const { user, onUpdateVoiceSettings } = renderSection()

    await user.click(screen.getByRole('combobox', { name: 'Coordinator voice' }))

    for (const voice of OPENAI_REALTIME_VOICES) {
      const label = voice.slice(0, 1).toUpperCase() + voice.slice(1)
      expect(screen.getByRole('option', { name: label })).toBeVisible()
    }

    await user.click(screen.getByRole('option', { name: 'Sage' }))

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      control: { ...getDefaultVoiceControlSettings(), coordinatorVoice: 'sage' }
    })
  })

  it('merges the agent voice mode onto the control', async () => {
    const { user, onUpdateVoiceSettings } = renderSection()

    await user.click(screen.getByRole('combobox', { name: 'Agent updates' }))
    await user.click(screen.getByRole('option', { name: 'Name the reporting agent' }))

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      control: { ...getDefaultVoiceControlSettings(), agentVoiceMode: 'per-agent' }
    })
  })

  it('merges the session limit onto the control, with Unlimited as zero minutes', async () => {
    const { user, onUpdateVoiceSettings } = renderSection()

    await user.click(screen.getByRole('combobox', { name: 'Max session length' }))
    await user.click(screen.getByRole('option', { name: 'Unlimited' }))

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      control: { ...getDefaultVoiceControlSettings(), maxSessionMinutes: 0 }
    })
  })

  it('merges the speech speed pick onto the control', async () => {
    const { user, onUpdateVoiceSettings } = renderSection()

    await user.click(screen.getByRole('combobox', { name: 'Speech speed' }))

    for (const label of ['1×', '1.25×', '1.5×']) {
      expect(screen.getByRole('option', { name: label })).toBeVisible()
    }

    await user.click(screen.getByRole('option', { name: '1.5×' }))

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      control: { ...getDefaultVoiceControlSettings(), voiceSpeed: 1.5 }
    })
  })

  it('merges the quiet-suspend limit onto the control, with Off as zero minutes', async () => {
    const { user, onUpdateVoiceSettings } = renderSection()

    await user.click(screen.getByRole('combobox', { name: 'Suspend when quiet' }))

    for (const label of ['Off', '2 minutes', '5 minutes', '15 minutes']) {
      expect(screen.getByRole('option', { name: label })).toBeVisible()
    }

    await user.click(screen.getByRole('option', { name: 'Off' }))

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      control: { ...getDefaultVoiceControlSettings(), idleSuspendMinutes: 0 }
    })
  })

  it('reflects control.voiceGating and merges the flip onto the control', async () => {
    const gatedOff: VoiceSettings = {
      ...getDefaultVoiceSettings(),
      control: { ...getDefaultVoiceControlSettings(), voiceGating: false }
    }
    const { user, onUpdateVoiceSettings } = renderSection(gatedOff)

    const gatingSwitch = screen.getByRole('switch', { name: 'Only stream when I speak' })
    expect(gatingSwitch).not.toBeChecked()
    await user.click(gatingSwitch)

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      control: { ...getDefaultVoiceControlSettings(), voiceGating: true }
    })
  })

  it('merges custom instructions onto the control on blur, not per keystroke', async () => {
    const { user, onUpdateVoiceSettings } = renderSection()

    const field = screen.getByRole('textbox', { name: 'Custom instructions' })
    await user.type(field, 'Be terse')
    expect(onUpdateVoiceSettings).not.toHaveBeenCalled()
    await user.tab()

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      control: { ...getDefaultVoiceControlSettings(), customInstructions: 'Be terse' }
    })
  })

  it('falls back to the default control for settings persisted before it existed', () => {
    // Why: control was added after voice settings first shipped; old persisted blobs lack it.
    const legacySettings: VoiceSettings = JSON.parse(
      JSON.stringify({ ...getDefaultVoiceSettings(), control: undefined })
    )
    renderSection(legacySettings)

    expect(screen.getByRole('switch', { name: 'Enable Full Voice Control' })).not.toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Coordinator voice' })).toHaveTextContent('Marin')
  })
})
