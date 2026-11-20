// @vitest-environment happy-dom
// A new bot's agent setup: an ordinary bot follows each agent's defaults; a bot from a link keeps the
// owner's permission apart from the agent.

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BotAgent } from '../../../../shared/bot-types'
import { useBotAgentSetup } from './use-bot-agent-setup'

const ALL: readonly BotAgent[] = ['claude', 'codex', 'pi']

describe('useBotAgentSetup with a kept permission', () => {
  it('keeps Ask through an agent that offers no permissions and back', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local', undefined, 'ask'))
    expect(result.current.setup).toEqual({ agent: 'claude', permissionMode: 'ask' })
    act(() => result.current.setSetup({ agent: 'pi' }))
    expect(result.current.setup).toEqual({ agent: 'pi' })
    expect(result.current.intent).toBe('ask')
    act(() => result.current.setSetup({ agent: 'claude' }))
    expect(result.current.setup).toEqual({ agent: 'claude', permissionMode: 'ask' })
    expect(result.current.intent).toBe('ask')
  })

  it('takes an explicit pick, and a cleared one on the same agent as the chats’ own', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local', undefined, 'ask'))
    act(() => result.current.setSetup({ agent: 'claude', permissionMode: 'full-access' }))
    expect(result.current.intent).toBe('full-access')
    act(() => result.current.setSetup({ agent: 'claude' }))
    expect(result.current.intent).toBe('inherit')
    expect(result.current.setup).toEqual({ agent: 'claude' })
    // Moving on to another agent keeps that choice rather than reviving Ask.
    act(() => result.current.setSetup({ agent: 'codex' }))
    expect(result.current.intent).toBe('inherit')
    act(() => result.current.setSetup({ agent: 'claude' }))
    expect(result.current.setup).toEqual({ agent: 'claude' })
  })
})

describe('useBotAgentSetup without one', () => {
  it('starts on the agent defaults and reports no kept permission', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local'))
    expect(result.current.setup).toEqual({ agent: 'claude' })
    expect(result.current.intent).toBeUndefined()
  })

  it('falls back to the next agent on its own defaults, not the vanished pick', () => {
    let choices: readonly BotAgent[] = ALL
    const { result, rerender } = renderHook(() => useBotAgentSetup(choices, 'local'))
    act(() => result.current.setSetup({ agent: 'codex', permissionMode: 'full-access' }))
    expect(result.current.setup).toEqual({ agent: 'codex', permissionMode: 'full-access' })
    choices = ['claude']
    rerender()
    expect(result.current.setup).toEqual({ agent: 'claude' })
  })
})
