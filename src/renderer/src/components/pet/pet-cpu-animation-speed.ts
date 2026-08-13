import { useEffect, useState } from 'react'

export const PET_CPU_POLL_MS = 2_000
export const PET_CPU_EMA_ALPHA = 0.25

const PET_ANIMATION_SPEED_MIN = 1
const PET_ANIMATION_SPEED_MAX = 1.5
const CPU_USAGE_MAX = 1

function clampCpuUsage(value: number): number {
  return Math.min(CPU_USAGE_MAX, Math.max(0, value))
}

function safeSpeedMultiplier(value: number): number {
  if (!Number.isFinite(value)) {
    return PET_ANIMATION_SPEED_MIN
  }
  return Math.min(PET_ANIMATION_SPEED_MAX, Math.max(PET_ANIMATION_SPEED_MIN, value))
}

export function applyPetCpuEma(previous: number | null, next: number): number {
  if (!Number.isFinite(next)) {
    return previous ?? 0
  }
  const sample = clampCpuUsage(next)
  return previous === null
    ? sample
    : previous + PET_CPU_EMA_ALPHA * (sample - clampCpuUsage(previous))
}

export function getPetAnimationSpeed(cpuUsage: number | null): number {
  if (cpuUsage === null || !Number.isFinite(cpuUsage)) {
    return PET_ANIMATION_SPEED_MIN
  }
  const normalized = clampCpuUsage(cpuUsage) / CPU_USAGE_MAX
  return PET_ANIMATION_SPEED_MIN + normalized * (PET_ANIMATION_SPEED_MAX - PET_ANIMATION_SPEED_MIN)
}

export function getPetFrameIntervalMs(fps: number, speedMultiplier: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 8
  return 1000 / (safeFps * safeSpeedMultiplier(speedMultiplier))
}

export function usePetCpuAnimationSpeed(active: boolean): number {
  const [smoothedCpu, setSmoothedCpu] = useState<number | null>(null)

  useEffect(() => {
    if (!active) {
      return
    }

    let cancelled = false
    let inFlight = false
    const getSystemCpuUsage = (window.api as Partial<typeof window.api> | undefined)?.pet
      ?.getSystemCpuUsage
    if (!getSystemCpuUsage) {
      return
    }

    const poll = async (): Promise<void> => {
      if (inFlight) {
        return
      }
      inFlight = true
      try {
        const usage = await getSystemCpuUsage()
        if (!cancelled && typeof usage === 'number' && Number.isFinite(usage)) {
          setSmoothedCpu((previous) => applyPetCpuEma(previous, usage))
        }
      } catch {
        // CPU sampling is advisory; keep the last stable speed on transient IPC failures.
      } finally {
        inFlight = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), PET_CPU_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active])

  return active ? getPetAnimationSpeed(smoothedCpu) : PET_ANIMATION_SPEED_MIN
}
