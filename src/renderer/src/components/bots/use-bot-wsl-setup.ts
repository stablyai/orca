// New bot's inline setup of a WSL distro picked under Computer › Add host › WSL distro.
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  WslHostAddResult,
  WslHostDistro
} from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { addWslHostDistro } from '@/components/sidebar/host-admission/wsl/add-wsl-host-distro'
import {
  wslHostAddRefusalMessage,
  wslHostStatusDetailMessage
} from '@/components/sidebar/host-admission/wsl/wsl-host-failure-text'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { laterBotWslSetupStage, type BotWslSetupStage } from './bot-wsl-setup-steps'

export type BotWslSetupState =
  | { phase: 'idle' }
  | {
      phase: 'running'
      distro: WslHostDistro
      stage: BotWslSetupStage | null
      /** What the add waits for, such as another install's lock. */
      wait: string | null
    }
  /** The host exists; New bot is learning its agents. */
  | { phase: 'finding-agents'; distro: WslHostDistro; environmentId: string }
  | { phase: 'failed'; distro: WslHostDistro; message: string; detail: string | null }

export type BotWslSetup = {
  state: BotWslSetupState
  start: (distro: WslHostDistro) => void
  retry: () => void
  /** Stops listening and forgets the add; main has no abort, so a running add finishes in the background. */
  cancel: () => void
  /** The host's agents are known: the card folds away. */
  finish: () => void
}

const IDLE: BotWslSetupState = { phase: 'idle' }

function failure(result: Extract<WslHostAddResult, { ok: false }>): {
  message: string
  detail: string | null
} {
  const message = wslHostAddRefusalMessage(result)
  // An uncoded failure is main's verbatim error: its first line leads, the rest sits behind Details.
  const [first, ...rest] = message.split(/\r?\n/)
  const summary = result.errorCode ? message : first.trim() || message
  const detail = result.message !== summary ? result.message : rest.length ? message : null
  return { message: summary, detail }
}

/** `onAdded` must be stable (a state setter): it picks the new host. */
export function useBotWslSetup(onAdded: (environmentId: string) => void): BotWslSetup {
  const [state, setState] = useState<BotWslSetupState>(IDLE)
  // Bumped by every start and cancel, so a detached add's answer changes nothing.
  const generation = useRef(0)
  const running = state.phase === 'running' ? state.distro.name.toLowerCase() : null

  useEffect(() => {
    if (!running) {
      return
    }
    // Every window hears every add's progress; only this distro's moves the card.
    return window.api.runtimeEnvironments?.wslHosts?.onAddProgress?.((progress) => {
      if (progress.distro.toLowerCase() !== running) {
        return
      }
      setState((previous) =>
        previous.phase === 'running'
          ? {
              ...previous,
              stage: laterBotWslSetupStage(previous.stage, progress.stage),
              wait: wslHostStatusDetailMessage(progress)
            }
          : previous
      )
    })
  }, [running])

  const start = useCallback(
    (distro: WslHostDistro): void => {
      generation.current += 1
      const current = generation.current
      setState({ phase: 'running', distro, stage: null, wait: null })
      const settle = (next: BotWslSetupState): void => {
        if (generation.current === current) {
          setState(next)
        }
      }
      // Picking the distro is the user's explicit start, as the Add dialog's Start and add is.
      void addWslHostDistro({ distro: distro.name, startIfStopped: true })
        .then((result) => {
          if (!result.ok) {
            settle({ phase: 'failed', distro, ...failure(result) })
            return
          }
          if (generation.current === current) {
            setState({ phase: 'finding-agents', distro, environmentId: result.environmentId })
            onAdded(result.environmentId)
          }
        })
        .catch((cause: unknown) => {
          const detail = readIpcErrorDetail(cause) ?? String(cause)
          settle({ phase: 'failed', distro, message: detail.split(/\r?\n/)[0], detail })
        })
    },
    [onAdded]
  )

  const cancel = useCallback((): void => {
    generation.current += 1
    setState(IDLE)
  }, [])

  return {
    state,
    start,
    retry: () => {
      if (state.phase === 'failed') {
        start(state.distro)
      }
    },
    cancel,
    finish: cancel
  }
}
