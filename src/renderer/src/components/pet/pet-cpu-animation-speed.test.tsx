// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PET_CPU_POLL_MS,
  applyPetCpuEma,
  getPetAnimationSpeed,
  getPetFrameIntervalMs,
  usePetCpuAnimationSpeed
} from './pet-cpu-animation-speed'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pet CPU animation speed', () => {
  it('CPU 사용량을 1.0x에서 1.5x 사이의 속도로 변환한다', () => {
    // Given / When / Then
    expect(getPetAnimationSpeed(null)).toBe(1)
    expect(getPetAnimationSpeed(-0.1)).toBe(1)
    expect(getPetAnimationSpeed(0.5)).toBe(1.25)
    expect(getPetAnimationSpeed(1)).toBe(1.5)
    expect(getPetAnimationSpeed(2.5)).toBe(1.5)
  })

  it('새 CPU 샘플에 EMA 평활화를 적용한다', () => {
    // Given / When / Then
    expect(applyPetCpuEma(null, 0.8)).toBe(0.8)
    expect(applyPetCpuEma(0.2, 1)).toBe(0.4)
    expect(applyPetCpuEma(0.4, Number.NaN)).toBe(0.4)
  })

  it('detected sprite 프레임 간격에 속도 배수를 적용한다', () => {
    // Given / When / Then
    expect(getPetFrameIntervalMs(8, 1)).toBe(125)
    expect(getPetFrameIntervalMs(8, 1.25)).toBe(100)
    expect(getPetFrameIntervalMs(8, 1.5)).toBeCloseTo(83.333, 3)
  })

  it('활성 상태에서 즉시 조회하고 2초마다 다시 조회한다', async () => {
    // Given
    vi.useFakeTimers()
    const getSystemCpuUsage = vi.fn().mockResolvedValueOnce(0.2).mockResolvedValueOnce(1)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pet: { getSystemCpuUsage } }
    })

    // When
    const { result } = renderHook(() => usePetCpuAnimationSpeed(true))
    await act(async () => {
      await Promise.resolve()
    })

    // Then
    expect(getSystemCpuUsage).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(1.1)

    // When
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PET_CPU_POLL_MS)
    })

    // Then
    expect(getSystemCpuUsage).toHaveBeenCalledTimes(2)
    expect(result.current).toBe(1.2)
  })

  it('비활성 상태에서는 조회하지 않고 기본 속도를 반환한다', async () => {
    // Given
    vi.useFakeTimers()
    const getSystemCpuUsage = vi.fn().mockResolvedValue(1)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pet: { getSystemCpuUsage } }
    })

    // When
    const { result } = renderHook(() => usePetCpuAnimationSpeed(false))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PET_CPU_POLL_MS * 2)
    })

    // Then
    expect(getSystemCpuUsage).not.toHaveBeenCalled()
    expect(result.current).toBe(1)
  })

  it('활성 상태에서 비활성 상태로 바뀌면 polling을 중단하고 기본 속도로 복귀한다', async () => {
    // Given
    vi.useFakeTimers()
    const getSystemCpuUsage = vi.fn().mockResolvedValue(0.8)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pet: { getSystemCpuUsage } }
    })
    const { result, rerender } = renderHook(({ active }) => usePetCpuAnimationSpeed(active), {
      initialProps: { active: true }
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toBe(1.4)

    // When
    rerender({ active: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PET_CPU_POLL_MS * 2)
    })

    // Then
    expect(getSystemCpuUsage).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(1)
  })
})
