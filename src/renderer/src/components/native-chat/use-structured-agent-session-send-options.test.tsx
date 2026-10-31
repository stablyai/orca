// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  getStructuredAgentSessionLaunchSelection: () => null
}))

import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'

import { projectRuntimePermission } from '../../../../shared/structured-agent-session-permission-option'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))

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
