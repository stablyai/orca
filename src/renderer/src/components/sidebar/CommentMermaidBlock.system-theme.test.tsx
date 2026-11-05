// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSystemPrefersDarkSubscriptionForTests } from '@/components/terminal-pane/use-system-prefers-dark'

const mermaidProps: { current: { isDark: boolean } | null } = vi.hoisted(() => ({ current: null }))

vi.mock('@/components/editor/MermaidBlock', () => ({
  default: (props: { isDark: boolean }) => {
    mermaidProps.current = props
    return null
  }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: { theme: 'system' } })
}))

import CommentMermaidBlock from './CommentMermaidBlock'

const originalMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  mermaidProps.current = null
  resetSystemPrefersDarkSubscriptionForTests()
  window.matchMedia = originalMatchMedia
})

describe('CommentMermaidBlock system theme', () => {
  it('follows a system color-scheme change while mounted', () => {
    let matches = false
    const listeners = new Set<EventListener>()
    const media = {
      get matches() {
        return matches
      },
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only reads `matches` and (un)subscribes to `change`.
    window.matchMedia = (() => media) as unknown as typeof window.matchMedia

    render(<CommentMermaidBlock content="graph TD; A-->B" />)
    expect(mermaidProps.current?.isDark).toBe(false)

    act(() => {
      matches = true
      for (const listener of listeners) {
        listener(new MediaQueryListEvent('change', { matches: true }))
      }
    })
    expect(mermaidProps.current?.isDark).toBe(true)
  })
})
