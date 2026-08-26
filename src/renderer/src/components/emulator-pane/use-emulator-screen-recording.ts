import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'

export type EmulatorRecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping'

type RecordingResult = { outputPath?: string }

export function useEmulatorScreenRecording(
  worktreeId: string,
  deviceName: string,
  isLive: boolean
) {
  const [status, setStatus] = useState<EmulatorRecordingStatus>('idle')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const startedAtRef = useRef(0)

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000))
    }, 1_000)
    return () => clearInterval(timer)
  }, [status])

  // A dropped stream means the capture process is gone too; don't strand the button.
  useEffect(() => {
    if (!isLive) {
      setStatus('idle')
      setElapsedSeconds(0)
    }
  }, [isLive])

  const start = useCallback(async () => {
    setStatus('starting')
    try {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.recordStart', {
        name: deviceName,
        worktree: worktreeId
      })
      startedAtRef.current = Date.now()
      setElapsedSeconds(0)
      setStatus('recording')
    } catch (error) {
      setStatus('idle')
      toast.error(
        translate(
          'auto.components.emulator.pane.use.emulator.screen.recording.9c7e2a1d40',
          'Could not start screen recording'
        ),
        { description: errorDescription(error) }
      )
    }
  }, [deviceName, worktreeId])

  const stop = useCallback(async () => {
    setStatus('stopping')
    try {
      const result = (await callRuntimeRpc({ kind: 'local' }, 'emulator.recordStop', {
        worktree: worktreeId
      })) as RecordingResult | null
      setStatus('idle')
      setElapsedSeconds(0)
      showSavedToast(result?.outputPath)
    } catch (error) {
      setStatus('idle')
      setElapsedSeconds(0)
      toast.error(
        translate(
          'auto.components.emulator.pane.use.emulator.screen.recording.4b1f0c88ea',
          'Could not save screen recording'
        ),
        { description: errorDescription(error) }
      )
    }
  }, [worktreeId])

  const toggle = useCallback(() => {
    if (status === 'recording') {
      void stop()
      return
    }
    if (status === 'idle') {
      void start()
    }
  }, [start, status, stop])

  return { status, elapsedSeconds, toggle }
}

function showSavedToast(outputPath?: string): void {
  const title = translate(
    'auto.components.emulator.pane.use.emulator.screen.recording.7d3a5b2c19',
    'Screen recording saved'
  )
  if (!outputPath) {
    toast.success(title)
    return
  }
  toast.success(title, {
    description: outputPath,
    action: {
      label: translate(
        'auto.components.emulator.pane.use.emulator.screen.recording.2e6f9a0b77',
        'Open'
      ),
      onClick: () => void window.api.shell.openPath(outputPath)
    }
  })
}

function errorDescription(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined
}

export function formatRecordingElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
