// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnimatedBotAvatarRenderer } from './AnimatedBotAvatarRenderer'
import type { AvatarKeyframedAnimation } from './avatar-pack-types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SAMPLE_ANIMATION: AvatarKeyframedAnimation = {
  version: 1,
  pack: 'chromahair',
  index: 0,
  state: 'idle',
  variant: 0,
  name: 'idle_0',
  duration: 2,
  once: false,
  vb: [0, 0, 100, 100],
  nodes: [
    { id: 'root', tag: 'svg', parent: null, slot: 0, attrs: {} },
    { id: 'defs', tag: 'defs', parent: 'root', slot: 0, attrs: {} },
    { id: 'clip', tag: 'clipPath', parent: 'defs', slot: 0, attrs: { id: 'o0' } },
    { id: 'filter', tag: 'filter', parent: 'defs', slot: 1, attrs: { id: 'f0' } },
    {
      id: 'matrix',
      tag: 'feColorMatrix',
      parent: 'filter',
      slot: 0,
      attrs: { type: 'hueRotate', values: '0' },
      tracks: {
        values: { times: [0, 1], values: [[15], [45]] }
      }
    },
    {
      id: 'transfer',
      tag: 'feComponentTransfer',
      parent: 'filter',
      slot: 1,
      attrs: {}
    },
    {
      id: 'funcR',
      tag: 'feFuncR',
      parent: 'transfer',
      slot: 0,
      attrs: { type: 'linear', slope: '1', intercept: '0' },
      tracks: {
        slope: { times: [0, 1], values: [[0.75], [1.25]] }
      }
    },
    {
      id: 'body',
      tag: 'g',
      parent: 'root',
      slot: 1,
      attrs: { 'clip-path': 'url(#o0)', filter: 'url(#f0)' }
    }
  ]
}

describe('AnimatedBotAvatarRenderer', () => {
  it('renders frame 0 statically under prefers-reduced-motion and scopes defs IDs across instances', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')

    const { container } = render(
      <div>
        <AnimatedBotAvatarRenderer animation={SAMPLE_ANIMATION} pack="chromahair" />
        <AnimatedBotAvatarRenderer animation={SAMPLE_ANIMATION} pack="chromahair" />
      </div>
    )

    expect(rafSpy).not.toHaveBeenCalled()

    const clips = container.querySelectorAll('clipPath')
    expect(clips).toHaveLength(2)
    const clipId0 = clips[0]?.getAttribute('id')
    const clipId1 = clips[1]?.getAttribute('id')
    expect(clipId0).toBeTruthy()
    expect(clipId1).toBeTruthy()
    expect(clipId0).not.toBe(clipId1)

    const groups = container.querySelectorAll('g')
    expect(groups[0]?.getAttribute('clip-path')).toBe(`url(#${clipId0})`)
    expect(groups[1]?.getAttribute('clip-path')).toBe(`url(#${clipId1})`)

    const matrix = container.querySelector('feColorMatrix')
    const funcR = container.querySelector('feFuncR')
    expect(matrix?.getAttribute('values')).toBe('15.0000')
    expect(funcR?.getAttribute('slope')).toBe('0.7500')
  })

  it('coalesces multiple live avatars onto one shared requestAnimationFrame loop and cancels on unmount', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42)
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')

    const { unmount } = render(
      <div>
        <AnimatedBotAvatarRenderer animation={SAMPLE_ANIMATION} pack="chromahair" />
        <AnimatedBotAvatarRenderer animation={SAMPLE_ANIMATION} pack="chromahair" />
        <AnimatedBotAvatarRenderer animation={SAMPLE_ANIMATION} pack="chromahair" />
      </div>
    )

    expect(rafSpy).toHaveBeenCalledTimes(1)
    unmount()
    expect(cancelSpy).toHaveBeenCalledWith(42)
  })
})
