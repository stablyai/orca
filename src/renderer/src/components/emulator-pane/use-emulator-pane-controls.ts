import { useCallback, useRef } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { EmulatorGesturePoint } from './emulator-screen-gesture'

export function useEmulatorPaneControls(worktreeId: string) {
  const nextRotateOrientationRef = useRef<'landscape_left' | 'portrait'>('landscape_left')

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
    await callRuntimeRpc({ kind: 'local' }, 'emulator.rotate', {
      orientation,
      worktree: worktreeId
    })
    nextRotateOrientationRef.current =
      orientation === 'landscape_left' ? 'portrait' : 'landscape_left'
  }, [worktreeId])

  return { sendTap, sendButton, sendGesture, sendRotate }
}
