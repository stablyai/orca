// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderFrameRow } from './NativeChatMessageList'

afterEach(cleanup)

describe('ProviderFrameRow', () => {
  it('renders a compact provider-kind summary with expandable bounded detail', () => {
    const { container } = render(
      <ProviderFrameRow
        block={{
          type: 'text',
          text: 'codex · notification:new/event',
          providerFrame: {
            provider: 'codex',
            kind: 'notification:new/event',
            payload: {
              head: '{"future":true}',
              byteLength: 15,
              digest: 'digest',
              truncated: false
            }
          }
        }}
      />
    )

    expect(container.querySelector('details')).toBeInTheDocument()
    expect(screen.getByText('codex')).toBeInTheDocument()
    expect(screen.getByText('notification:new/event')).toBeInTheDocument()
    expect(screen.getByText('{"future":true}')).toBeInTheDocument()
  })
})
