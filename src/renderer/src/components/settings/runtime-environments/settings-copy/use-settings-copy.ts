import { useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { PortableSettingsImportResult } from '../../../../../../shared/portable-settings'
import {
  applySettingsCopy,
  isSettingsCopyPairingChanged,
  isSettingsCopyUnsupported,
  previewSettingsCopy,
  type SettingsCopyCall,
  type SettingsCopyDirection,
  type SettingsCopyPreview
} from './settings-copy'

export type SettingsCopyState =
  | { phase: 'checking' }
  | { phase: 'ready'; preview: SettingsCopyPreview }
  | { phase: 'applying'; preview: SettingsCopyPreview }
  | { phase: 'applied'; preview: SettingsCopyPreview; result: PortableSettingsImportResult }
  /**
   * `unsupported`: the paired Orca predates settings copy and needs an update.
   * `pairingChanged`: it was paired again after the preview, which must run again.
   */
  | { phase: 'failed'; message: string; unsupported: boolean; pairingChanged: boolean }

export type SettingsCopyController = {
  open: boolean
  direction: SettingsCopyDirection
  state: SettingsCopyState
  start: () => void
  chooseDirection: (direction: SettingsCopyDirection) => void
  retry: () => void
  apply: () => void
  close: () => void
}

const call: SettingsCopyCall = (target, method, params, options) =>
  callRuntimeRpc(target, method, params, options)

function failedState(error: unknown): SettingsCopyState {
  return {
    phase: 'failed',
    message: error instanceof Error ? error.message : String(error),
    unsupported: isSettingsCopyUnsupported(error),
    pairingChanged: isSettingsCopyPairingChanged(error)
  }
}

/** Preview-then-apply copy of portable settings between this computer and one paired Orca. */
export function useSettingsCopy(environmentId: string): SettingsCopyController {
  const [open, setOpen] = useState(false)
  const [direction, setDirection] = useState<SettingsCopyDirection>('send')
  const [state, setState] = useState<SettingsCopyState>({ phase: 'checking' })
  const mountedRef = useMountedRef()
  // A newer check, a direction switch or closing the dialog makes older answers stale.
  const requestIdRef = useRef(0)

  function track<T>(work: Promise<T>, onDone: (value: T) => SettingsCopyState): void {
    const requestId = ++requestIdRef.current
    const isCurrent = (): boolean => mountedRef.current && requestId === requestIdRef.current
    work.then(
      (value) => isCurrent() && setState(onDone(value)),
      (error: unknown) => isCurrent() && setState(failedState(error))
    )
  }

  function check(next: SettingsCopyDirection): void {
    setState({ phase: 'checking' })
    track(previewSettingsCopy(call, environmentId, next), (preview) => ({
      phase: 'ready',
      preview
    }))
  }

  return {
    open,
    direction,
    state,
    start: () => {
      setOpen(true)
      setDirection('send')
      check('send')
    },
    chooseDirection: (next) => {
      if (next === direction || state.phase === 'applying') {
        return
      }
      setDirection(next)
      check(next)
    },
    retry: () => check(direction),
    apply: () => {
      if (state.phase !== 'ready' || state.preview.changed.length === 0) {
        return
      }
      const { preview } = state
      setState({ phase: 'applying', preview })
      track(applySettingsCopy(call, environmentId, direction, preview), (result) => ({
        phase: 'applied',
        preview,
        result
      }))
    },
    close: () => {
      // The write cannot be taken back, so the dialog stays until it reports the result.
      if (state.phase === 'applying') {
        return
      }
      requestIdRef.current++
      setOpen(false)
    }
  }
}
