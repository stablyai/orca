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
  it('shows the mode a kept one runs as where the agent lacks it, and a model edit there keeps it', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local', undefined, 'ask'))
    act(() => result.current.setSetup({ agent: 'claude', permissionMode: 'accept-edits' }))
    expect(result.current.intent).toBe('accept-edits')
    // Codex has no Accept edits; its chats run a saved one as Ask, so the picker shows Ask.
    act(() => result.current.setSetup({ agent: 'codex' }))
    expect(result.current.setup).toEqual({ agent: 'codex', permissionMode: 'ask' })
    expect(result.current.intent).toBe('accept-edits')
    // A model or effort edit commits the shown mode; it is not a switch to the chats' own.
    const launch = { model: 'gpt-x', options: { effort: 'high' } }
    act(() => result.current.setSetup({ agent: 'codex', launch, permissionMode: 'ask' }))
    expect(result.current.intent).toBe('accept-edits')
    expect(result.current.setup).toEqual({ agent: 'codex', launch, permissionMode: 'ask' })
    // Back on Claude, carried as the kept mode, it is Accept edits again.
    act(() => result.current.setSetup({ agent: 'claude', permissionMode: 'accept-edits' }))
    expect(result.current.setup).toEqual({ agent: 'claude', permissionMode: 'accept-edits' })
  })

  it('takes a mode picked on the fallback agent, and clearing it there as the chats’ own', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local', undefined, 'accept-edits'))
    act(() => result.current.setSetup({ agent: 'codex' }))
    act(() => result.current.setSetup({ agent: 'codex', permissionMode: 'full-access' }))
    expect(result.current.intent).toBe('full-access')
    act(() => result.current.setSetup({ agent: 'codex' }))
    expect(result.current.intent).toBe('inherit')
    expect(result.current.setup).toEqual({ agent: 'codex' })
  })

  it('takes the shown fallback when the owner chooses it, so Claude no longer revives the kept mode', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local', undefined, 'accept-edits'))
    act(() => result.current.setSetup({ agent: 'codex' }))
    expect(result.current.setup).toEqual({ agent: 'codex', permissionMode: 'ask' })
    act(() => result.current.setSetup({ agent: 'codex', permissionMode: 'ask' }, true))
    expect(result.current.intent).toBe('ask')
    act(() => result.current.setSetup({ agent: 'claude', permissionMode: 'ask' }))
    expect(result.current.setup).toEqual({ agent: 'claude', permissionMode: 'ask' })
  })

  it('takes Same as chats chosen on another agent’s pane as the chats’ own', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local', undefined, 'ask'))
    act(() => result.current.setSetup({ agent: 'codex' }, true))
    expect(result.current.intent).toBe('inherit')
    expect(result.current.setup).toEqual({ agent: 'codex' })
  })

  it('takes Use chat defaults on an agent without permissions as the chats’ own', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local', undefined, 'full-access'))
    act(() => result.current.setSetup({ agent: 'pi' }))
    act(() => result.current.setSetup({ agent: 'pi', launch: { model: 'pi-x' } }))
    expect(result.current.intent).toBe('full-access')
    // Use chat defaults resets the agent's setup and reports the permission as chosen.
    act(() => result.current.setSetup({ agent: 'pi' }, true))
    expect(result.current.intent).toBe('inherit')
    act(() => result.current.setSetup({ agent: 'claude' }))
    expect(result.current.setup).toEqual({ agent: 'claude' })
  })

  it('takes another mode picked on another agent’s pane', () => {
    const { result } = renderHook(() => useBotAgentSetup(ALL, 'local', undefined, 'ask'))
    act(() => result.current.setSetup({ agent: 'codex', permissionMode: 'auto' }))
    expect(result.current.intent).toBe('auto')
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
