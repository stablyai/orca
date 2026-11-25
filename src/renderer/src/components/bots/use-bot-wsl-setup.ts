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
  /** `message` is a coded refusal's copy; null for main's verbatim error, which only `detail` holds. */
  | { phase: 'failed'; distro: WslHostDistro; message: string | null; detail: string | null }

export type BotWslSetup = {
  state: BotWslSetupState
  start: (distro: WslHostDistro) => void
  retry: () => void
  /** Stops listening and forgets the add (main has no abort, so a running add finishes in the
   *  background), and gives back the computer picked before; also once the host exists. */
  cancel: () => void
  /** Folds the card away and keeps the computer now picked: its agents are known, the owner picked
   *  another computer, or the agent check took too long and the usual host or agent states take over. */
  finish: () => void
}

const IDLE: BotWslSetupState = { phase: 'idle' }
/** A new host that never answers for its agents hands over to the usual host states after this. */
export const BOT_WSL_FINDING_AGENTS_TIMEOUT_MS = 30_000

function failure(result: Extract<WslHostAddResult, { ok: false }>): {
  message: string | null
  detail: string | null
} {
  // An uncoded failure is main's verbatim error (often a command line): it sits behind Details.
  return result.errorCode
    ? { message: wslHostAddRefusalMessage(result), detail: null }
    : { message: null, detail: result.message }
}

/** `onAdded` picks the new host and `onCancelAdded` gives back the earlier pick; both must be stable. */
export function useBotWslSetup(
  onAdded: (environmentId: string) => void,
  onCancelAdded: () => void
): BotWslSetup {
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

  const finish = useCallback((): void => {
    generation.current += 1
    setState(IDLE)
  }, [])
  const findingAgents = state.phase === 'finding-agents'
  useEffect(() => {
    if (!findingAgents) {
      return
    }
    const timer = window.setTimeout(finish, BOT_WSL_FINDING_AGENTS_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [findingAgents, finish])

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
          settle({ phase: 'failed', distro, message: null, detail })
        })
    },
    [onAdded]
  )

  const cancel = (): void => {
    if (state.phase === 'finding-agents') {
      onCancelAdded()
    }
    finish()
  }

  return {
    state,
    start,
    retry: () => {
      if (state.phase === 'failed') {
        start(state.distro)
      }
    },
    cancel,
    finish
  }
}
