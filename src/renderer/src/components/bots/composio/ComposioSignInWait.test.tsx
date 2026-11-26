// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { ComposioSignInWait } from './ComposioSignInWait'

vi.mock('./composio-client', () => ({
  useComposioBot: vi.fn(() => ({
    status: { key: 'ok', limit: null, added: false },
    connections: { connections: [], pending: [] },
    error: null
  })),
  openComposioPage: vi.fn()
}))

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (key: string, fallback?: string, vars?: Record<string, string>) => {
    let text = fallback ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`{{${k}}}`, 'g'), v)
      }
    }
    return text
  }
}))

afterEach(cleanup)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ComposioSignInWait reads only the bot's hostId and id.
const testBot = {
  id: 'bot-test',
  name: 'Test Bot',
  hostId: 'local'
} as Bot

const testApp = { slug: 'teams', name: 'Microsoft Teams' }

describe('ComposioSignInWait', () => {
  it('shows only Close and Try again on ordinary failure', () => {
    render(
      <ComposioSignInWait
        bot={testBot}
        app={testApp}
        connectError="Composio didn’t answer. Check your connection."
        onDone={() => {}}
        onRetry={() => {}}
        onChangeKey={() => {}}
        onClose={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Replace key' })).toBeNull()
  })

  it('shows Replace key when connectError indicates missing permissions and calls onChangeKey', () => {
    const onChangeKey = vi.fn()
    const onRetry = vi.fn()
    const onClose = vi.fn()

    const permError =
      'Composio: This API key does not have the permissions required for POST /api/v3.1/tool_router/session. This route requires "session_management" write access, but the key has read access for "session_management".'

    render(
      <ComposioSignInWait
        bot={testBot}
        app={testApp}
        connectError={permError}
        onDone={() => {}}
        onRetry={onRetry}
        onChangeKey={onChangeKey}
        onClose={onClose}
      />
    )

    const replaceBtn = screen.getByRole('button', { name: 'Replace key' })
    expect(replaceBtn).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()

    fireEvent.click(replaceBtn)
    expect(onChangeKey).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })
})
