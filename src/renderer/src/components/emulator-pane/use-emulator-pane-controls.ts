import { useCallback, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  EmulatorButtonOptions,
  EmulatorPosture
} from '../../../../shared/emulator-device-controls'
import type { EmulatorDeviceVisualOrientation } from './emulator-device-frame-layout'
import type { EmulatorGesturePoint } from './emulator-screen-gesture'

type UseEmulatorPaneControlsArgs = {
  worktreeId: string
  onControlError: (error: unknown) => void
  onControlSuccess: () => void
  onDisplaySettled: () => void
}

const ROTATION_SEQUENCE = [
  'portrait',
  'landscape_left',
  'portrait_upside_down',
  'landscape_right'
] as const

type Rotation = (typeof ROTATION_SEQUENCE)[number]

export function useEmulatorPaneControls({
  worktreeId,
  onControlError,
  onControlSuccess,
  onDisplaySettled
}: UseEmulatorPaneControlsArgs) {
  const orientationEpochRef = useRef(0)
  const rotationRef = useRef<Rotation>('portrait')
  const displayCommandPendingRef = useRef(false)
  const [visualOrientation, setVisualOrientation] =
    useState<EmulatorDeviceVisualOrientation>('portrait')
  const [displayCommandPending, setDisplayCommandPending] = useState(false)
  const sendTap = useCallback(
    async (x: number, y: number) => {
      try {
        await callRuntimeRpc({ kind: 'local' }, 'emulator.tap', { x, y, worktree: worktreeId })
        onControlSuccess()
      } catch (error) {
        onControlError(error)
      }
    },
    [onControlError, onControlSuccess, worktreeId]
  )

  const sendButton = useCallback(
    async (name: string, options?: EmulatorButtonOptions): Promise<void> => {
      try {
        await callRuntimeRpc({ kind: 'local' }, 'emulator.button', {
          name,
          worktree: worktreeId,
          ...options
        })
        onControlSuccess()
      } catch (error) {
        onControlError(error)
      }
    },
    [onControlError, onControlSuccess, worktreeId]
  )
  const sendGesture = useCallback(
    async (points: EmulatorGesturePoint[]) => {
      try {
        await callRuntimeRpc({ kind: 'local' }, 'emulator.gesture', {
          points,
          worktree: worktreeId
        })
        onControlSuccess()
      } catch (error) {
        onControlError(error)
      }
    },
    [onControlError, onControlSuccess, worktreeId]
  )

  const sendDisplayCommand = useCallback(
    async (run: () => Promise<void>, epoch: number, onSuccess: () => void): Promise<void> => {
      if (displayCommandPendingRef.current) {
        return
      }
      displayCommandPendingRef.current = true
      setDisplayCommandPending(true)
      try {
        await run()
        if (orientationEpochRef.current !== epoch) {
          return
        }
        onSuccess()
        onControlSuccess()
        onDisplaySettled()
      } catch (error) {
        if (orientationEpochRef.current === epoch) {
          onControlError(error)
        }
      } finally {
        if (orientationEpochRef.current === epoch) {
          displayCommandPendingRef.current = false
          setDisplayCommandPending(false)
        }
      }
    },
    [onControlError, onControlSuccess, onDisplaySettled]
  )

  const sendRotate = useCallback(
    async (direction?: 'left' | 'right'): Promise<void> => {
      if (displayCommandPendingRef.current) {
        return
      }
      const epoch = orientationEpochRef.current
      const currentIndex = ROTATION_SEQUENCE.indexOf(rotationRef.current)
      let next: Rotation
      if (direction === undefined) {
        next = rotationRef.current === 'portrait' ? 'landscape_left' : 'portrait'
      } else {
        const offset = direction === 'left' ? 1 : ROTATION_SEQUENCE.length - 1
        next = ROTATION_SEQUENCE[(currentIndex + offset) % ROTATION_SEQUENCE.length]
      }
      await sendDisplayCommand(
        async () => {
          await callRuntimeRpc({ kind: 'local' }, 'emulator.rotate', {
            orientation: next,
            worktree: worktreeId
          })
        },
        epoch,
        () => {
          rotationRef.current = next
          setVisualOrientation(
            next === 'portrait' || next === 'portrait_upside_down' ? 'portrait' : 'landscape'
          )
        }
      )
    },
    [sendDisplayCommand, worktreeId]
  )

  const sendPosture = useCallback(
    async (posture: EmulatorPosture): Promise<void> => {
      if (displayCommandPendingRef.current) {
        return
      }
      const epoch = orientationEpochRef.current
      await sendDisplayCommand(
        async () => {
          await callRuntimeRpc({ kind: 'local' }, 'emulator.posture', {
            posture,
            worktree: worktreeId
          })
        },
        epoch,
        () => {}
      )
    },
    [sendDisplayCommand, worktreeId]
  )

  const resetVisualOrientation = useCallback(() => {
    orientationEpochRef.current += 1
    rotationRef.current = 'portrait'
    displayCommandPendingRef.current = false
    setVisualOrientation('portrait')
    setDisplayCommandPending(false)
  }, [])

  return {
    sendTap,
    sendButton,
    sendGesture,
    sendRotate,
    sendPosture,
    visualOrientation,
    displayCommandPending,
    resetVisualOrientation
  }
}
