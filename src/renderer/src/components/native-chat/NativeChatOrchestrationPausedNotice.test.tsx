// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatOrchestrationPausedNotice } from './NativeChatOrchestrationPausedNotice'

describe('NativeChatOrchestrationPausedNotice', () => {
  afterEach(cleanup)

  it('stays hidden while dispatch state is loading or settled', () => {
    const { rerender } = render(<NativeChatOrchestrationPausedNotice />)

    expect(screen.queryByRole('status')).toBeNull()

    rerender(<NativeChatOrchestrationPausedNotice dispatchStatus="completed" />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['pending', 'dispatched'] as const)(
    'persists recovery guidance for an active %s Dispatch',
    (dispatchStatus) => {
      render(<NativeChatOrchestrationPausedNotice dispatchStatus={dispatchStatus} />)

      const notice = screen.getByRole('status')
      expect(notice.textContent).toContain('Orchestration paused')
      expect(notice.textContent).toContain('Structured Chat blocks terminal prompts and sends')
      expect(notice.textContent).toContain('Orchestration messages remain queued')
      expect(notice.textContent).toContain(
        'switch to Terminal, then check the Orca inbox with orca orchestration check'
      )
    }
  )
})
