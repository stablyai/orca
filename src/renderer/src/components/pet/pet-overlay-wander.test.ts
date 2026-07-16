// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  choosePetWanderTarget,
  getPetWanderAnimationName,
  shouldPetWander,
  stepPetWanderPosition,
  usePetWander,
  type PetWanderPosition
} from './pet-overlay-wander'

type PositionUpdate =
  | PetWanderPosition
  | ((currentPosition: PetWanderPosition) => PetWanderPosition)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pet overlay wander helpers', () => {
  it('only wanders for visible idle pets that can animate', () => {
    expect(
      shouldPetWander({
        enabled: true,
        documentVisible: true,
        reducedMotion: false,
        dragging: false,
        animationName: 'idle'
      })
    ).toBe(true)

    expect(
      shouldPetWander({
        enabled: true,
        documentVisible: true,
        reducedMotion: false,
        dragging: false,
        animationName: 'running'
      })
    ).toBe(false)
    expect(
      shouldPetWander({
        enabled: true,
        documentVisible: false,
        reducedMotion: false,
        dragging: false,
        animationName: 'idle'
      })
    ).toBe(false)
    expect(
      shouldPetWander({
        enabled: true,
        documentVisible: true,
        reducedMotion: true,
        dragging: false,
        animationName: 'idle'
      })
    ).toBe(false)
  })

  it('uses directional running animations while wandering', () => {
    expect(getPetWanderAnimationName('idle', true, -1)).toBe('running-left')
    expect(getPetWanderAnimationName('idle', true, 1)).toBe('running-right')
    expect(getPetWanderAnimationName('review', false, 1)).toBe('review')
  })

  it('chooses a target inside the viewport with bounded vertical drift', () => {
    const randomValues = [0.5, 0.75]
    const random = vi.fn(() => randomValues.shift() ?? 0)

    expect(
      choosePetWanderTarget({
        position: { x: 100, y: 150 },
        size: 100,
        viewport: { width: 500, height: 300 },
        random
      })
    ).toEqual({
      x: 200,
      y: 127.5
    })
  })

  it('moves toward a two-dimensional target and pauses after arrival', () => {
    const moving = stepPetWanderPosition({
      position: { x: 0, y: 0 },
      target: { x: 32, y: 24 },
      pausedUntil: 0,
      horizontalDirection: 1,
      now: 1_000,
      deltaMs: 1_000,
      size: 20,
      viewport: { width: 200, height: 200 },
      random: () => 0
    })

    expect(moving.position.x).toBeCloseTo(25.6)
    expect(moving.position.y).toBeCloseTo(19.2)
    expect(moving.target).toEqual({ x: 32, y: 24 })
    expect(moving.horizontalDirection).toBe(1)

    const arrived = stepPetWanderPosition({
      position: { x: 30, y: 24 },
      target: { x: 32, y: 24 },
      pausedUntil: 0,
      horizontalDirection: 1,
      now: 2_000,
      deltaMs: 1_000,
      size: 20,
      viewport: { width: 200, height: 200 },
      random: () => 0.5
    })

    expect(arrived.position).toEqual({ x: 32, y: 24 })
    expect(arrived.target).toBeNull()
    expect(arrived.pausedUntil).toBe(4_000)
  })

  it('drops an existing target when it falls outside the current viewport bounds', () => {
    const next = stepPetWanderPosition({
      position: { x: 100, y: 40 },
      target: { x: 900, y: 40 },
      pausedUntil: 0,
      horizontalDirection: 1,
      now: 1_000,
      deltaMs: 1_000,
      size: 20,
      viewport: { width: 200, height: 200 },
      random: () => 0
    })

    expect(next.target).toEqual({ x: 16, y: 16 })
    expect(next.position.x).toBeLessThan(100)
    expect(next.horizontalDirection).toBe(-1)
  })

  it('advances position after the first animation frame establishes a baseline', () => {
    const frames: FrameRequestCallback[] = []
    let rafId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      frames.push(callback)
      rafId += 1
      return rafId
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(Math, 'random').mockReturnValue(0)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })

    const positionUpdates: PositionUpdate[] = []
    const { result } = renderHook(() => {
      const [position, setPositionState] = useState<PetWanderPosition>({ x: 100, y: 40 })
      const setPosition = useCallback((nextPosition: PositionUpdate) => {
        positionUpdates.push(nextPosition)
        setPositionState(nextPosition)
      }, [])
      return {
        position,
        ...usePetWander({
          enabled: true,
          documentVisible: true,
          reducedMotion: false,
          dragging: false,
          animationName: 'idle',
          position,
          size: 20,
          setPosition
        })
      }
    })

    expect(result.current.animationName).toBe('idle')

    act(() => {
      frames.shift()?.(1_000)
    })
    expect(positionUpdates).toHaveLength(0)

    act(() => {
      frames.shift()?.(1_060)
    })
    expect(result.current.position.x).toBeLessThan(100)
    expect(result.current.animationName).toBe('running-left')
    expect(typeof positionUpdates[0]).not.toBe('function')

    act(() => {
      frames.shift()?.(5_000)
    })
    expect(result.current.animationName).toBe('idle')
  })
})
