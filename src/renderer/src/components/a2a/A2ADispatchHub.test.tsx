// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { A2ADispatchHub } from './A2ADispatchHub'
import { useA2AStore } from '../../store/a2a-traces-store'

describe('A2ADispatchHub', () => {
  beforeEach(() => {
    useA2AStore.getState().clearTraces()
    useA2AStore.getState().setHubOpen(false)
    useA2AStore.getState().setHubTab('topology')
    useA2AStore.getState().setSelectedAgentIndex(null)
  })

  afterEach(() => {
    cleanup()
    useA2AStore.getState().clearTraces()
  })

  it('renders null when isHubOpen is false', () => {
    const { container } = render(<A2ADispatchHub />)
    expect(container.firstChild).toBeNull()
  })

  it('renders modal dialog when isHubOpen is true', () => {
    useA2AStore.getState().setHubOpen(true)
    render(<A2ADispatchHub />)

    expect(screen.getByTestId('a2a-dispatch-hub-modal')).toBeDefined()
    expect(screen.getByText('A2A 視覺化協同調度中樞')).toBeDefined()
    expect(screen.getByText('Grokbot Hub')).toBeDefined()
    expect(screen.getByText('拓撲視圖')).toBeDefined()
    expect(screen.getByText('活動流')).toBeDefined()
  })

  it('switches between topology and activity stream views', () => {
    useA2AStore.getState().setHubOpen(true)
    render(<A2ADispatchHub />)

    // Initial is topology view
    expect(screen.getByText('拓撲視圖')).toBeDefined()

    // Switch to Activity Stream
    const streamBtn = screen.getByText('活動流')
    fireEvent.click(streamBtn)

    expect(useA2AStore.getState().hubTab).toBe('stream')
    expect(screen.getByPlaceholderText(/過濾 Agent/)).toBeDefined()

    // Switch back to Topology
    const topoBtn = screen.getByText('拓撲視圖')
    fireEvent.click(topoBtn)
    expect(useA2AStore.getState().hubTab).toBe('topology')
  })

  it('displays agent nodes in topology view and inspects agent on click', () => {
    act(() => {
      useA2AStore.getState().addTrace({
        from: '@2',
        to: '@5',
        type: 'send',
        text: 'run tests'
      })
      useA2AStore.getState().setHubOpen(true)
    })

    render(<A2ADispatchHub />)

    // Check agent nodes in topology
    expect(screen.getByText('#2')).toBeDefined()
    expect(screen.getByText('#5')).toBeDefined()

    // Click node #2
    const node2 = screen.getByText('#2')
    fireEvent.click(node2)

    expect(useA2AStore.getState().selectedAgentIndex).toBe(2)
    expect(screen.getByText('接管終端 (Take Control)')).toBeDefined()
  })

  it('commander bar dispatches commands and adds trace to store', async () => {
    useA2AStore.getState().setHubOpen(true)
    render(<A2ADispatchHub />)

    const input = screen.getByPlaceholderText(/下達跨 Agent 指令/)
    fireEvent.change(input, { target: { value: '@5 run smoke test' } })

    const dispatchBtn = screen.getByText('派工')
    fireEvent.click(dispatchBtn)

    const state = useA2AStore.getState()
    expect(state.recentTraces).toHaveLength(1)
    expect(state.recentTraces[0].toIndex).toBe(5)
    expect(state.recentTraces[0].text).toBe('run smoke test')
  })

  it('closes modal when Escape key is pressed', () => {
    useA2AStore.getState().setHubOpen(true)
    render(<A2ADispatchHub />)

    expect(useA2AStore.getState().isHubOpen).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useA2AStore.getState().isHubOpen).toBe(false)
  })

  it('triggers simulate team flow on button click', () => {
    vi.useFakeTimers()
    useA2AStore.getState().setHubOpen(true)
    render(<A2ADispatchHub />)

    const simBtn = screen.getByText('模擬協同')
    fireEvent.click(simBtn)

    expect(useA2AStore.getState().recentTraces.length).toBeGreaterThanOrEqual(1)

    act(() => {
      vi.advanceTimersByTime(2500)
    })

    expect(useA2AStore.getState().recentTraces.length).toBe(3)
    vi.useRealTimers()
  })
})
