// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalRemoteRuntimeReconnectBanner } from './TerminalRemoteRuntimeReconnectBanner'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

describe('TerminalRemoteRuntimeReconnectBanner', () => {
  it('shows quiet bounded automatic recovery without a manual action', () => {
    render(<TerminalRemoteRuntimeReconnectBanner phase="backoff" onReconnect={vi.fn()} />)

    expect(screen.getByText('Reconnecting to remote runtime')).toBeInTheDocument()
    expect(screen.getByText(/retry for up to one minute/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers one explicit reconnect action after automatic recovery stops', async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    render(<TerminalRemoteRuntimeReconnectBanner phase="disconnected" onReconnect={onReconnect} />)

    expect(screen.getByText('Remote runtime disconnected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })
})
