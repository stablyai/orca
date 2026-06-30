/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useTerminalErrorTable } from './use-terminal-error-table'

describe('useTerminalErrorTable', () => {
  it('appends a new entry on first sight', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => result.current.push('SSH connection lost'))
    expect(result.current.errors).toEqual([
      { message: 'SSH connection lost', count: 1, lastSeenAt: 1000 }
    ])
  })

  it('dedups identical entries within the window', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => result.current.push('SSH connection lost'))
    t = 5_000
    act(() => result.current.push('SSH connection lost'))
    expect(result.current.errors).toHaveLength(1)
    expect(result.current.errors[0].count).toBe(2)
    expect(result.current.errors[0].lastSeenAt).toBe(5_000)
  })

  it('evicts expired entries before dedup', () => {
    let t = 1_000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => result.current.push('SSH connection lost'))
    t = 40_000
    act(() => result.current.push('SSH connection lost'))
    expect(result.current.errors).toHaveLength(1)
    expect(result.current.errors[0].count).toBe(1)
  })

  it('caps the table at 5 entries', () => {
    let t = 0
    const { result } = renderHook(() => useTerminalErrorTable(() => (t += 100)))
    act(() => {
      for (let i = 0; i < 7; i++) {
        result.current.push(`msg-${i}`)
      }
    })
    expect(result.current.errors).toHaveLength(5)
    expect(result.current.errors[0].message).toBe('msg-2')
    expect(result.current.errors.at(-1)?.message).toBe('msg-6')
  })

  it('clear() empties the table', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => {
      result.current.push('msg-a')
      result.current.push('msg-b')
    })
    act(() => result.current.clear())
    expect(result.current.errors).toEqual([])
  })

  it('does not grow past 5 entries under sustained identical errors', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => {
      for (let i = 0; i < 100; i++) {
        result.current.push('Remote Orca runtime connection lost')
      }
      t = 5_000 // inside window
      for (let i = 0; i < 100; i++) {
        result.current.push('Remote Orca runtime connection lost')
      }
    })
    expect(result.current.errors).toHaveLength(1)
    expect(result.current.errors[0].count).toBe(200)
  })
})
