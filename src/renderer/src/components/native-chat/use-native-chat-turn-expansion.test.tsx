// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { useNativeChatTurnExpansion } from './use-native-chat-turn-expansion'

const TURN_KEYS = [undefined, 't1', 't1', 't2', 't2']

function setExpandByDefault(nativeChatExpandFinishedTurns: boolean): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), nativeChatExpandFinishedTurns }
  })
}

afterEach(() => useAppStore.setState({ settings: null }))

describe('useNativeChatTurnExpansion', () => {
  it('folds every turn by default and opens only what the reader toggles', () => {
    setExpandByDefault(false)
    const { result } = renderHook(() => useNativeChatTurnExpansion(TURN_KEYS))
    expect([...result.current.expandedTurnIds]).toEqual([])
    act(() => result.current.toggleExpandedTurn('t1'))
    expect([...result.current.expandedTurnIds]).toEqual(['t1'])
  })

  it('opens every turn when the setting is on and lets the reader close one', () => {
    setExpandByDefault(true)
    const { result } = renderHook(() => useNativeChatTurnExpansion(TURN_KEYS))
    expect([...result.current.expandedTurnIds]).toEqual(['t1', 't2'])
    act(() => result.current.toggleExpandedTurn('t1'))
    expect([...result.current.expandedTurnIds]).toEqual(['t2'])
    act(() => result.current.toggleExpandedTurn('t1'))
    expect([...result.current.expandedTurnIds]).toEqual(['t1', 't2'])
  })

  it('drops the reader’s toggles when the setting flips', () => {
    setExpandByDefault(false)
    const { result } = renderHook(() => useNativeChatTurnExpansion(TURN_KEYS))
    act(() => result.current.toggleExpandedTurn('t1'))
    act(() => setExpandByDefault(true))
    expect([...result.current.expandedTurnIds]).toEqual(['t1', 't2'])
    act(() => setExpandByDefault(false))
    expect([...result.current.expandedTurnIds]).toEqual([])
  })
})
