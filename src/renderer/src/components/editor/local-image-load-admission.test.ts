import { describe, expect, it, vi } from 'vitest'
import {
  LocalImageLoadAdmission,
  MAX_ACTIVE_LOCAL_IMAGE_LOADS,
  MAX_ADMITTED_LOCAL_IMAGE_LOADS
} from './local-image-load-admission'

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

describe('LocalImageLoadAdmission', () => {
  it('starts only the bounded number of image reads concurrently', async () => {
    const admission = new LocalImageLoadAdmission()
    const releases: (() => void)[] = []
    const task = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve(releases.length))
        })
    )

    const loads = Array.from({ length: MAX_ACTIVE_LOCAL_IMAGE_LOADS + 1 }, () =>
      admission.admit(task)
    )
    await flushMicrotasks()
    expect(task).toHaveBeenCalledTimes(MAX_ACTIVE_LOCAL_IMAGE_LOADS)

    releases[0]?.()
    await flushMicrotasks()
    expect(task).toHaveBeenCalledTimes(MAX_ACTIVE_LOCAL_IMAGE_LOADS + 1)

    for (const release of releases) {
      release()
    }
    await Promise.all(loads)
  })

  it('rejects excess admission and can release every queued load', async () => {
    const admission = new LocalImageLoadAdmission()
    const releases: (() => void)[] = []
    const admitted = Array.from({ length: MAX_ADMITTED_LOCAL_IMAGE_LOADS }, () =>
      admission.admit(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve)
          })
      )
    )

    await flushMicrotasks()
    expect(admission.admit(() => Promise.resolve())).toBeNull()
    admission.clearPending()
    for (const release of releases) {
      release()
    }
    await Promise.all(admitted)
  })
})
