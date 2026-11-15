import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bot } from '../../../../../shared/bot-types'
import { botLookAround, type LookAroundPatch } from '../../../../../shared/bots/bot-look-around'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { botRefKey } from '@/lib/bot-hosts'
import { viewerTimeZone } from '@/components/bots/bot-look-around-copy'
import {
  lookAroundHostTakesCustom,
  refreshLookAroundStatus,
  type LookAroundStatus
} from '@/components/bots/use-look-around-status'

import {
  createLookEditState,
  currentLookEdit,
  lookEditState,
  stageLookEdit,
  withLookEditPreflight,
  type LookEditIntent,
  type LookEditState
} from './look-around-edit-intent'

type HeldEdit = {
  patch: LookAroundPatch
  state: LookEditState
  intent: LookEditIntent
  waitingForClock: boolean
  asking: boolean
}

export function useLookAroundEdit(
  bot: Bot,
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>,
  status: LookAroundStatus | null,
  readError: unknown
) {
  const setting = botLookAround(bot)
  const key = botRefKey(bot)
  const localIntent = useRef(createLookEditState(key))
  const [held, setHeld] = useState<HeldEdit | null>(null)
  const hostZone = status?.upNext.hostTimeZone
  const clockReady =
    (!readError && hostZone !== undefined) || hasRuntimeRpcErrorCode(readError, 'method_not_found')
  const askZone = !setting.timezone && hostZone !== undefined && hostZone !== viewerTimeZone()

  const save = useCallback(
    (next: LookAroundPatch, intent: LookEditIntent, state: LookEditState): void => {
      const commit = (current: LookEditState = state): void => {
        const kept = currentLookEdit(current, intent, next)
        if (Object.values(kept).every((value) => value === undefined)) {
          return
        }
        const schedule = kept.every !== undefined || kept.times !== undefined
        void update({ lookAround: schedule ? { ...kept, editorTimeZone: viewerTimeZone() } : kept })
      }
      const custom =
        next.times !== undefined || next.every === 'custom' || next.timezone !== undefined
      if (!custom) {
        commit()
        return
      }
      void withLookEditPreflight(state, () => lookAroundHostTakesCustom(bot), commit)
    },
    [bot, update]
  )

  // A completed host read or committed zone releases the pending schedule edit.
  useEffect(() => {
    if (!held || held.state.key !== key) {
      return
    }
    const current = lookEditState(key, held.state)
    if (
      held.intent.schedule !== current.latest.schedule ||
      held.intent.timezone !== current.latest.timezone
    ) {
      return
    }
    if (!setting.timezone && (!held.waitingForClock || !clockReady)) {
      return
    }
    if (askZone) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- The host response resolves a pending user edit.
      setHeld({ ...held, waitingForClock: false })
      return
    }
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- The host clock or saved zone admits this pending save.
    setHeld(null)
    save(held.patch, held.intent, current)
  }, [held, key, clockReady, askZone, setting.timezone, save])

  const change = (next: LookAroundPatch): void => {
    const schedule = next.every !== undefined || next.times !== undefined
    const choosing = schedule || next.timezone !== undefined
    const state = lookEditState(key, localIntent.current)
    localIntent.current = state
    const intent = stageLookEdit(state, next)
    if (schedule && next.timezone === undefined && !setting.timezone && (!clockReady || askZone)) {
      setHeld({
        patch: {
          ...next,
          ...(next.times !== undefined && next.every === undefined ? { every: 'custom' } : {})
        },
        intent,
        state,
        waitingForClock: !clockReady,
        asking: true
      })
      if (!clockReady) {
        refreshLookAroundStatus(bot)
      }
      return
    }
    if (choosing) {
      setHeld(null)
    }
    save(next, intent, state)
  }

  const visibleHeld = held?.state.key === key ? held : null
  return {
    change,
    heldEdit: visibleHeld?.patch ?? null,
    asking: visibleHeld?.asking ?? false,
    answerZone: (timezone: string | null) =>
      change({
        ...(visibleHeld
          ? currentLookEdit(visibleHeld.state, visibleHeld.intent, visibleHeld.patch)
          : {}),
        timezone
      }),
    dismissZone: () => {
      setHeld((previous) =>
        previous ? { ...previous, waitingForClock: false, asking: false } : null
      )
    }
  }
}
