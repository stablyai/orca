// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { buildNativeChatPickerItems } from '../../../../../../shared/native-chat/input/native-chat-picker-items'
import { NativeChatPickerMenu } from './NativeChatAutocompleteMenus'

afterEach(() => {
  cleanup()
})

describe('skill argument hints in the picker', () => {
  it('shows a session-reported skill hint beside the skill token', () => {
    const items = buildNativeChatPickerItems(
      [
        {
          name: 'goal',
          description: 'Set a goal',
          argumentHint: '[<condition> | clear]',
          builtin: true
        }
      ],
      [],
      '',
      '/',
      [{ name: 'demo', description: 'Demo skill', argumentHint: '<target>' }]
    )
    render(
      <div className="native-chat-appearance">
        <NativeChatPickerMenu
          autocomplete={{
            mode: 'slash',
            query: '',
            triggerKey: '/:0',
            prefix: '/',
            dispatchable: true,
            grouped: false,
            commandsEnabled: true,
            skillsEnabled: true,
            skillStatus: 'ready',
            items
          }}
          activeIndex={0}
          listboxId="skill-hint-menu"
          onChoose={() => {}}
          onRetry={() => {}}
        />
      </div>
    )
    expect(screen.getByText('<target>')).toBeTruthy()
    expect(screen.getByText('[<condition> | clear]')).toBeTruthy()
  })
})
