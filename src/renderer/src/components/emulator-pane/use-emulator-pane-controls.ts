import { useCallback, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { EmulatorDeviceVisualOrientation } from './emulator-device-frame-layout'
import type { EmulatorGesturePoint } from './emulator-screen-gesture'

export function useEmulatorPaneControls(worktreeId: string, onRotateSettled?: () => void) {
  const nextRotateOrientationRef = useRef<'landscape_left' | 'portrait'>('landscape_left')
  const visualOrientationEpochRef = useRef(0)
  const [visualOrientation, setVisualOrientation] =
    useState<EmulatorDeviceVisualOrientation>('portrait')

  const sendTap = useCallback(
    async (x: number, y: number) => {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.tap', { x, y, worktree: worktreeId })
    },
    [worktreeId]
  )

  const sendButton = useCallback(
    async (name: string) => {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.button', { name, worktree: worktreeId })
    },
    [worktreeId]
  )

  const sendGesture = useCallback(
    async (points: EmulatorGesturePoint[]) => {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.gesture', { points, worktree: worktreeId })
    },
    [worktreeId]
  )

  const sendRotate = useCallback(async () => {
    const orientation = nextRotateOrientationRef.current
    const epoch = visualOrientationEpochRef.current
    await callRuntimeRpc({ kind: 'local' }, 'emulator.rotate', {
      orientation,
      worktree: worktreeId
    })
    if (visualOrientationEpochRef.current !== epoch) {
      return null
    }
    const nextVisualOrientation = orientation === 'landscape_left' ? 'landscape' : 'portrait'
    setVisualOrientation(nextVisualOrientation)
    nextRotateOrientationRef.current =
      orientation === 'landscape_left' ? 'portrait' : 'landscape_left'
    onRotateSettled?.()
    return nextVisualOrientation
  }, [onRotateSettled, worktreeId])

  const resetVisualOrientation = useCallback(() => {
    visualOrientationEpochRef.current += 1
    nextRotateOrientationRef.current = 'landscape_left'
    setVisualOrientation('portrait')
  }, [])

  return { sendTap, sendButton, sendGesture, sendRotate, visualOrientation, resetVisualOrientation }
}
