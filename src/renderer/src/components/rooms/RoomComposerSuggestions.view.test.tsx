// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomParticipant } from '../../../../shared/rooms'
import { RoomComposerSuggestions, type RoomComposerSuggestion } from './RoomComposerSuggestions'

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function suggestion(identity: string, displayName: string): RoomComposerSuggestion {
  return {
    value: `@${identity}`,
    label: `@${identity}`,
    identity,
    displayName,
    participant: { identity, displayName, actorKind: 'agent', agent: 'codex' } as RoomParticipant
  }
}

describe('RoomComposerSuggestions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 16)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders both names and animates filtered rows out', () => {
    const codex = suggestion('codex', 'Reviewer')
    const claude = suggestion('claude', 'Researcher')
    const { rerender, unmount } = render(
      <RoomComposerSuggestions suggestions={[codex, claude]} activeIndex={0} onSelect={vi.fn()} />
    )

    const menu = document.querySelector('[data-room-composer-suggestions]')!
    expect(menu.getAttribute('data-room-composer-suggestions')).toBe('closed')
    expect(menu.className).not.toContain('overflow-hidden')
    act(() => vi.advanceTimersByTime(16))
    expect(menu.getAttribute('data-room-composer-suggestions')).toBe('closed')
    act(() => vi.advanceTimersByTime(16))
    expect(menu.getAttribute('data-room-composer-suggestions')).toBe('open')
    const surface = document.querySelector('[data-room-composer-suggestions-surface]')!
    expect(surface.className).toContain('transition-[opacity,translate]')
    expect(surface.className).toContain('ease-out')
    expect(surface.getAttribute('style')).toContain(
      'cubic-bezier(0.12, 0.9, 0.2, 1), cubic-bezier(0.16, 1, 0.3, 1)'
    )
    expect(surface.className).toContain('translate-y-0')
    expect(surface.className).toContain('opacity-100')
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled()
    expect(screen.getByText('Reviewer')).toBeTruthy()
    expect(screen.getByText('@codex')).toBeTruthy()

    rerender(<RoomComposerSuggestions suggestions={[claude]} activeIndex={0} onSelect={vi.fn()} />)
    expect(screen.getByText('Reviewer').closest('[aria-hidden="true"]')).toBeTruthy()
    expect(screen.getByText('Reviewer').closest('[aria-hidden="true"]')?.className).toContain(
      'ease'
    )
    act(() => vi.advanceTimersByTime(200))
    expect(screen.queryByText('Reviewer')).toBeNull()
    expect(screen.getByText('Researcher')).toBeTruthy()

    rerender(
      <RoomComposerSuggestions suggestions={[codex, claude]} activeIndex={0} onSelect={vi.fn()} />
    )
    expect(screen.getByText('Reviewer').closest('[aria-hidden="true"]')).toBeTruthy()
    act(() => vi.advanceTimersByTime(16))
    expect(screen.getByText('Reviewer').closest('[aria-hidden="true"]')).toBeTruthy()
    act(() => vi.advanceTimersByTime(16))
    expect(screen.getByText('Reviewer').closest('[aria-hidden="true"]')).toBeNull()
    unmount()
  })

  it('slides and fades the filled menu before unmounting it', () => {
    const codex = suggestion('codex', 'Reviewer')
    const { rerender } = render(
      <RoomComposerSuggestions suggestions={[codex]} activeIndex={0} onSelect={vi.fn()} />
    )
    act(() => vi.advanceTimersByTime(32))
    rerender(<RoomComposerSuggestions suggestions={[]} activeIndex={0} onSelect={vi.fn()} />)

    const menu = document.querySelector('[data-room-composer-suggestions]')!
    expect(menu.getAttribute('data-room-composer-suggestions')).toBe('closed')
    const surface = document.querySelector('[data-room-composer-suggestions-surface]')!
    expect(surface.className).toContain('translate-y-16')
    expect(surface.className).toContain('opacity-0')
    expect(screen.getByText('Reviewer').closest('[aria-hidden="true"]')).toBeNull()
    act(() => vi.advanceTimersByTime(500))
    expect(document.querySelector('[data-room-composer-suggestions]')).toBeTruthy()
    fireEvent.transitionEnd(surface)
    expect(document.querySelector('[data-room-composer-suggestions]')).toBeNull()
  })

  it('keeps the latest filter during rapid typing', () => {
    const codex = suggestion('codex', 'Reviewer')
    const claude = suggestion('claude', 'Researcher')
    const { rerender } = render(
      <RoomComposerSuggestions suggestions={[codex, claude]} activeIndex={0} onSelect={vi.fn()} />
    )
    act(() => vi.advanceTimersByTime(32))
    rerender(<RoomComposerSuggestions suggestions={[claude]} activeIndex={0} onSelect={vi.fn()} />)
    act(() => vi.advanceTimersByTime(100))
    rerender(<RoomComposerSuggestions suggestions={[codex]} activeIndex={0} onSelect={vi.fn()} />)
    act(() => vi.advanceTimersByTime(200))

    expect(screen.getByText('Reviewer')).toBeTruthy()
    expect(screen.queryByText('Researcher')).toBeNull()
  })
})
