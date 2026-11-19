// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BotHowToAsk } from './BotHowToAsk'
import { slackHowToAsk } from './slack/bot-slack-copy'

afterEach(cleanup)

describe('BotHowToAsk', () => {
  it('shows a name with markup as typed, not as tags', () => {
    render(<BotHowToAsk text={slackHowToAsk({ name: '<b>Bo</b> & co' })} />)
    expect(screen.getByText('@<b>Bo</b> & co').tagName).toBe('CODE')
    expect(document.querySelector('b')).toBeNull()
  })
})
