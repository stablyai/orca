// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatStatusFooter } from './NativeChatStatusFooter'

describe('NativeChatStatusFooter', () => {
  afterEach(cleanup)

  it('renders two stable, scannable rows without changing the composer width', () => {
    render(
      <NativeChatStatusFooter
        data={{
          primary: ['gpt-5.6-sol', 'xhigh', '77k/1M', 'leo-corp +1'],
          stage: 'разведка',
          next: 'спека в issue #156',
          questions: 0,
          blocked: 0,
          agents: 2
        }}
      />
    )

    expect(screen.getByTestId('native-chat-status-primary')).toHaveTextContent(
      'gpt-5.6-sol • xhigh • 77k/1M • leo-corp +1'
    )
    expect(screen.getByTestId('native-chat-status-stage')).toHaveTextContent(
      'stage: разведка → спека в issue #156 · Q:0 B:0 Ag:2'
    )
    expect(screen.getByTestId('native-chat-status-footer')).toHaveClass('min-w-0')
  })
})
