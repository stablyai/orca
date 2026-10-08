import { useEffect, useRef } from 'react'
import { getNativeViewOcclusionSnapshot } from '@/lib/native-view-occlusion'
import type { DesktopBrowserViewInput } from '../../../../../shared/desktop-browser-view-input'
import type { DesktopBrowserPage } from './desktop-browser-page-registry'
import type { DesktopBrowserPagePresentation } from './desktop-browser-page-presentation'

type KeyInput = Extract<DesktopBrowserViewInput, { kind: 'key' }>
type MouseInput = Extract<DesktopBrowserViewInput, { kind: 'mouse'; type: 'down' | 'move' | 'up' }>
type Owner = { isCurrent: () => boolean } | null
const pageQueues = new WeakMap<DesktopBrowserPage, Promise<void>>()

export function useDesktopBrowserPageInput({
  page,
  state,
  owner
}: {
  page: DesktopBrowserPage
  state: () => DesktopBrowserPagePresentation
  owner: () => Owner
}): {
  send: (input: DesktopBrowserViewInput) => boolean
  checkpoint: () => number
  pressKey: (input: KeyInput, checkpoint: number) => void
  releaseKey: (input: KeyInput) => void
  pressPointer: (pointerId: number, input: MouseInput) => boolean
  releasePointer: (pointerId: number, input?: MouseInput) => void
  flush: () => void
  onMode: (forwarded: boolean) => void
} {
  const identity = {
    browserPageId: page.state.browserPageId,
    generation: page.state.generation
  }
  const keys = useRef(new Map<string, KeyInput>())
  const pointers = useRef(new Map<number, MouseInput>())
  const epoch = useRef(0)
  const send = (input: DesktopBrowserViewInput, release = false): boolean => {
    const current = state()
    const accepted =
      release ||
      (current.active &&
        !current.inputLocked &&
        !current.hidden &&
        !getNativeViewOcclusionSnapshot().windowBlocked)
    if (!accepted) {
      return false
    }
    const currentOwner = owner()
    const queue = pageQueues.get(page) ?? Promise.resolve()
    const operation = queue.then(async () => {
      if (
        !page.destroyed &&
        (release ||
          (currentOwner?.isCurrent() &&
            state().active &&
            !state().inputLocked &&
            !state().hidden &&
            !getNativeViewOcclusionSnapshot().windowBlocked))
      ) {
        await page.api.input({ ...identity, input })
      }
    })
    pageQueues.set(
      page,
      operation.catch((error: unknown) =>
        console.warn('[browser] desktop page input failed:', error)
      )
    )
    return true
  }
  const flush = (): void => {
    epoch.current++
    for (const input of keys.current.values()) {
      send({ ...input, type: 'up', text: undefined }, true)
    }
    keys.current.clear()
    for (const input of pointers.current.values()) {
      send({ ...input, type: 'up', buttons: 0 }, true)
    }
    pointers.current.clear()
  }
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- Cleanup must retain the page that owned the held input.
  useEffect(() => () => flush(), [page])
  useEffect(() => {
    const current = state()
    if (!current.active || current.inputLocked || current.hidden) {
      flush()
    }
  })
  return {
    send,
    checkpoint: () => epoch.current,
    pressKey: (input, checkpoint) => {
      if (checkpoint === epoch.current && send(input)) {
        keys.current.set(input.code, input)
      }
    },
    releaseKey: (input) => {
      if (keys.current.delete(input.code)) {
        send(input, true)
      } else {
        send(input)
      }
    },
    pressPointer: (pointerId, input) => {
      if (send(input)) {
        pointers.current.set(pointerId, input)
        return true
      }
      return false
    },
    releasePointer: (pointerId, input) => {
      const held = pointers.current.get(pointerId)
      if (held) {
        pointers.current.delete(pointerId)
        send(
          input
            ? { ...held, ...input, type: 'up', buttons: 0 }
            : { ...held, type: 'up', buttons: 0 },
          true
        )
      }
    },
    flush,
    onMode: (forwarded) => {
      if (!forwarded) {
        flush()
      }
    }
  }
}
