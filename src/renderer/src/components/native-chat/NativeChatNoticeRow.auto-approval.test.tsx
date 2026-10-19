// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatTextBlock } from '../../../../shared/native-chat-types'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'

afterEach(cleanup)

const APPROVED =
  'Automatic approval review approved (risk: medium, authorization: high): Only the requested documentation is committed; nothing is pushed.'

function warning(text = APPROVED): NativeChatTextBlock {
  return {
    type: 'text',
    tone: 'warning',
    text,
    providerFrame: {
      provider: 'codex',
      kind: 'notification:warning',
      payload: {
        head: JSON.stringify({ message: text }),
        byteLength: 256,
        digest: 'test',
        truncated: false
      }
    }
  }
}

describe('automatic approval review notices', () => {
  it.each(['notification:warning', 'notification:guardianWarning'])(
    'starts a successful %s compact, without waiting for its turn to finish',
    (kind) => {
      const block = warning()
      render(
        <NativeChatNoticeRow
          block={{ ...block, providerFrame: { ...block.providerFrame!, kind } }}
        />
      )
      const toggle = screen.getByRole('button', { name: 'Automatic approval granted' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText(APPROVED)).not.toBeInTheDocument()
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText(APPROVED)).toBeVisible()
      expect(screen.getByText('Details')).toBeInTheDocument()
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText(APPROVED)).not.toBeInTheDocument()
    }
  )

  it.each([
    'Automatic approval review rejected (risk: high, authorization: low): Permission is required.',
    'Automatic approval review denied: Permission is required.',
    'Automatic approval review timed out.',
    'Approval required to run this command.',
    'A configuration warning mentions Automatic approval review approved (risk: low).'
  ])('keeps an actionable or unrelated notice visible: %s', (text) => {
    render(<NativeChatNoticeRow block={warning(text)} />)
    expect(screen.getByText(text)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Automatic approval granted' })).toBeNull()
  })

  it.each([
    { providerFrame: undefined },
    { providerFrame: { ...warning().providerFrame!, provider: 'claude' } },
    { providerFrame: { ...warning().providerFrame!, kind: 'notification:configWarning' } },
    { tone: 'error' },
    { failure: { kind: 'notSignedIn' as const } },
    { presentation: 'compaction-skipped' }
  ])('does not disguise a different source or a failure: %o', (override) => {
    render(<NativeChatNoticeRow block={{ ...warning(), ...override }} />)
    expect(screen.getByText(APPROVED)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Automatic approval granted' })).toBeNull()
  })
})
