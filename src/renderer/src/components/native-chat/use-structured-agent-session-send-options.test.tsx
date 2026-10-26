// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  getStructuredAgentSessionLaunchSelection: () => null
}))

import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))

function sendOptionsFor(
  takesSendOptions: boolean,
  pending: Record<string, string>,
  seedOptions: Record<string, string> = { model: 'sonnet', effort: 'high' }
) {
  const optionStateRef = {
    current: applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
      CLAUDE_SESSION_OPTION_CATALOG,
      {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          { id: 'opus[1m]', label: 'Opus', isDefault: false, efforts: levels('low', 'xhigh') },
          { id: 'sonnet', label: 'Sonnet', isDefault: true, efforts: levels('low', 'high') }
        ]
      },
      { newLaunch: true }
    )
  }
  const { result } = renderHook(() =>
    useStructuredAgentSessionSendOptions(
      'session-1',
      { kind: 'new', seedOptions, heldOptions: {} },
      {
        optionStateRef,
        pendingOptionsRef: { current: pending },
        optionView: structuredAgentSessionOptionView,
        takesSendOptions
      }
    )
  )
  return result.current
}

describe('what each composer send carries', () => {
  it('carries the shown model and effort to a host that takes them, on every send', () => {
    const sendOptions = sendOptionsFor(true, {})
    expect(sendOptions()).toEqual({ model: 'sonnet', effort: 'high' })
    expect(sendOptions()).toEqual({ model: 'sonnet', effort: 'high' })
  })

  it('carries a pick still on its way, resolved as the picker shows it', () => {
    expect(sendOptionsFor(true, { model: 'opus[1m]', effort: 'low' })()).toMatchObject({
      model: 'opus[1m]',
      effort: 'low'
    })
    expect(sendOptionsFor(true, { model: 'claude-retired' })()).toMatchObject({
      model: 'claude-retired'
    })
  })

  it('carries nothing to an older host', () => {
    expect(sendOptionsFor(false, {})()).toBeUndefined()
  })
})
