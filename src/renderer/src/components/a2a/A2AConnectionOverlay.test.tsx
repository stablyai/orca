// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { A2AConnectionOverlay } from './A2AConnectionOverlay'
import { useA2AStore } from '../../store/a2a-traces-store'

describe('A2AConnectionOverlay', () => {
  beforeEach(() => {
    useA2AStore.getState().clearTraces()
  })

  afterEach(() => {
    cleanup()
    useA2AStore.getState().clearTraces()
  })

  it('renders overlay container', () => {
    render(<A2AConnectionOverlay />)
    expect(screen.getByTestId('a2a-connection-overlay')).toBeDefined()
  })

  it('renders SVG beams and badges when an active link is present', () => {
    act(() => {
      useA2AStore.getState().addTrace({
        from: '@2',
        to: '@5',
        type: 'send',
        text: 'npm test'
      })
    })

    const { container } = render(<A2AConnectionOverlay />)
    const svg = container.querySelector('svg')
    expect(svg).toBeDefined()
    expect(container.querySelector('.a2a-link-beam')).toBeDefined()

    expect(screen.getByText('#2')).toBeDefined()
    expect(screen.getByText('#5')).toBeDefined()
    expect(screen.getByText('npm test')).toBeDefined()
  })

  it('allows dismissing an active trace via close button', () => {
    let traceId = ''
    act(() => {
      const trace = useA2AStore.getState().addTrace({
        from: '@2',
        to: '@8',
        type: 'message',
        text: 'review please'
      })
      traceId = trace.id
    })

    expect(traceId).toBeTruthy()
    render(<A2AConnectionOverlay />)
    expect(useA2AStore.getState().activeLinks).toHaveLength(1)

    const dismissBtn = screen.getByLabelText('Dismiss trace')
    fireEvent.click(dismissBtn)

    expect(useA2AStore.getState().activeLinks).toHaveLength(0)
  })

  it('toggles HUD and can trigger test traces', () => {
    render(<A2AConnectionOverlay />)

    // Initially no traces, trigger button shouldn't show
    expect(screen.queryByTestId('a2a-hud-trigger')).toBeNull()

    act(() => {
      useA2AStore.getState().addTrace({ from: '@1', to: '@2' })
    })

    const triggerBtn = screen.getByTestId('a2a-hud-trigger')
    expect(triggerBtn).toBeDefined()

    fireEvent.click(triggerBtn)
    expect(screen.getByText('A2A 通訊軌跡 (Trace)')).toBeDefined()

    // Click demo #2 ➔ #5 button
    const demoBtn = screen.getByText('#2 ➔ #5')
    fireEvent.click(demoBtn)

    const state = useA2AStore.getState()
    expect(state.activeLinks.some((l) => l.fromIndex === 2 && l.toIndex === 5)).toBe(true)

    // Click Open Hub button
    const openHubBtn = screen.getByTitle('展開完整 A2A 調度中樞 (Grokbot Hub)')
    fireEvent.click(openHubBtn)
    expect(useA2AStore.getState().isHubOpen).toBe(true)
  })
})
