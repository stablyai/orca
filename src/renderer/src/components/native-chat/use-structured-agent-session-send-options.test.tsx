// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  getStructuredAgentSessionLaunchSelection: () => null
}))

import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { projectRuntimePermission } from '../../../../shared/structured-agent-session-permission-option'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))

function sendOptionsFor(
  takesSendOptions: boolean,
  pending: Record<string, string>,
  seedOptions: Record<string, string> = { model: 'sonnet', effort: 'high' },
  takesSelection = false
) {
  const optionStateRef = {
    current: applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
      CLAUDE_SESSION_OPTION_CATALOG,
      {
        origin: 'probe',
        fetchedAt: 1,
        fastModeSupport: { supported: true },
        models: [
          { id: 'opus[1m]', label: 'Opus', isDefault: false, efforts: levels('low', 'xhigh') },
          {
            id: 'sonnet',
            label: 'Sonnet',
            isDefault: true,
            efforts: levels('low', 'high'),
            supportsFastMode: true
          }
        ]
      },
      { newLaunch: true }
    )
  }
  const { result } = renderHook(() =>
    useStructuredAgentSessionSendOptions(
      'session-1',
      { kind: 'new', seedOptions },
      {
        optionStateRef,
        optionView: (state, seed) => ({
          ...projectRuntimePermission(
            structuredAgentSessionOptionView(state, seed, pending),
            undefined,
            null
          ),
          permissionOwnSupported: null
        }),
        takesSelection,
        takesSendOptions
      }
    )
  )
  return result.current
}

describe('what each composer send carries', () => {
  it('carries the shown model and effort to a host that takes them, on every send', () => {
    const sendOptions = sendOptionsFor(true, {})
    expect(sendOptions()).toEqual({ options: { model: 'sonnet', effort: 'high' } })
    expect(sendOptions()).toEqual({ options: { model: 'sonnet', effort: 'high' } })
  })

  it('carries a pick still on its way, resolved as the picker shows it', () => {
    expect(sendOptionsFor(true, { model: 'opus[1m]', effort: 'low' })()).toMatchObject({
      options: { model: 'opus[1m]', effort: 'low' }
    })
    expect(sendOptionsFor(true, { model: 'claude-retired' })()).toMatchObject({
      options: { model: 'claude-retired' }
    })
  })

  it('captures the same full shown tuple on a capable host, including explicit Fast Off', () => {
    expect(sendOptionsFor(false, { fastMode: 'false' }, undefined, true)()).toEqual({
      selection: { model: 'sonnet', effort: 'high', fastMode: 'false' }
    })
  })

  it('carries nothing to an older host', () => {
    expect(sendOptionsFor(false, {})()).toEqual({})
  })
})

it('desktop capture freezes only accepted echoed inputs; empty origin differs from legacy absence', () => {
  const state = createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
  const answer = {
    models: [
      {
        id: 'opus[1m]',
        label: 'Opus',
        isDefault: false,
        efforts: levels('high'),
        supportsFastMode: true
      }
    ],
    fastModeSupport: { supported: true },
    current: {
      model: 'opus[1m]',
      effort: 'high',
      fastMode: false,
      confirmed: ['model', 'effort'],
      acceptedInputSources: { model: 'saved' as const, fastMode: 'policy' as const }
    }
  }
  const source = {
    optionStateRef: {
      current: applyStructuredAgentSessionOptions(state, CLAUDE_SESSION_OPTION_CATALOG, answer)
    },
    optionView: (current: typeof state) => ({
      ...projectRuntimePermission(
        structuredAgentSessionOptionView(current, undefined, {}),
        undefined,
        null
      ),
      permissionOwnSupported: null
    }),
    takesSelection: true,
    takesSendOptions: false
  }
  const { result } = renderHook(() =>
    useStructuredAgentSessionSendOptions('session-2', undefined, source)
  )
  const captured = result.current()
  expect(captured).toEqual({ selection: { model: 'opus[1m]', fastMode: 'false' } })
  source.optionStateRef.current = applyStructuredAgentSessionOptions(
    state,
    CLAUDE_SESSION_OPTION_CATALOG,
    { ...answer, current: { ...answer.current, acceptedInputSources: {} } }
  )
  expect(result.current()).toEqual({ selection: {} })
  source.optionStateRef.current = applyStructuredAgentSessionOptions(
    state,
    CLAUDE_SESSION_OPTION_CATALOG,
    { ...answer, current: { ...answer.current, acceptedInputSources: undefined } }
  )
  expect(result.current()).toEqual({
    selection: { model: 'opus[1m]', effort: 'high', fastMode: 'false' }
  })
  expect(captured).toEqual({ selection: { model: 'opus[1m]', fastMode: 'false' } })
})
