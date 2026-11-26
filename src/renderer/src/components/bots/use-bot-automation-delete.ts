// Deleting a bot's automations from its Activity tab: one admission per row, the delete sent to the
// incarnation that listed it, then a hide until the host's next read stops listing it. Lives with the
// tab (not the Automations section, which an open item unmounts), so an outcome still lands.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { deleteBotAutomation } from '../automations/hosts/automation-host-client'
import { reconcileBotAutomationDelete } from './bot-automation-delete-reconciliation'
import {
  AUTOMATION_HIDE_TTL_MS,
  hiddenAutomationIds,
  nextAutomationHideExpiry,
  pruneAutomationHides,
  type BotAutomationHide
} from './bot-automation-delete-hides'
import {
  botReadAuthorityKey,
  sameBotReadAuthority,
  type BotReadAuthority
} from './bot-read-authority'
import type { BotActivityWithAuthority, useBotActivityAuthorityRead } from './use-bot-activity'

/** What a Delete asked for, captured from the row as shown when it was asked. */
export type BotAutomationDeleteIntent = {
  botKey: string
  generation: symbol
  id: string
  name: string
  /** The incarnation whose read listed the row. */
  authority: BotReadAuthority
  /** The row was in trouble at admission. Keep it listed if folded while pending. */
  admittedAsTrouble: boolean
}

type BotAutomationDeleteRoute = Omit<BotAutomationDeleteIntent, 'admittedAsTrouble'>
type DeleteOp = BotAutomationDeleteIntent & { opId: number; opKey: string }

export type BotAutomationPending = { opId: number; admittedAsTrouble: boolean }
export type BotAutomationDeleteOutcome = 'hidden' | 'omitted' | 'trouble-cleared' | 'uncertain'
type CheckFoldedTrouble = (read: BotActivityWithAuthority['activity']) => boolean
export type BotAutomationDeleteAdmission = {
  opId: number
  settled: Promise<BotAutomationDeleteOutcome>
}

type DeleteMembership = 'listed' | 'absent' | 'stale'

export type BotAutomationDeletion = {
  /** The current read's incarnation, null until a read lands. */
  authority: BotReadAuthority | null
  botKey: string
  generation: symbol
  /** Ids hidden under the current incarnation. */
  hidden: ReadonlySet<string>
  /** Ids being deleted under the current incarnation. */
  pending: ReadonlyMap<string, BotAutomationPending>
  offline: boolean
  currentReadFor: (intent: BotAutomationDeleteRoute) => BotActivityWithAuthority | null
  membership: (intent: BotAutomationDeleteRoute) => DeleteMembership
  ownsFocus: (intent: BotAutomationDeleteIntent) => boolean
  canAdmit: (intent: BotAutomationDeleteRoute) => boolean
  admit: (
    intent: BotAutomationDeleteIntent,
    troubleClearedBy?: CheckFoldedTrouble
  ) => BotAutomationDeleteAdmission | null
}

type DeleteState = {
  key: string
  generation: symbol
  hides: readonly BotAutomationHide[]
  ops: ReadonlyMap<string, DeleteOp>
}

const NO_HIDES: readonly BotAutomationHide[] = []
const NO_OPS: ReadonlyMap<string, DeleteOp> = new Map()

function emptyDeleteState(key: string): DeleteState {
  return { key, generation: Symbol(), hides: NO_HIDES, ops: NO_OPS }
}

export function useBotAutomationDelete(
  bot: BotRef,
  activity: ReturnType<typeof useBotActivityAuthorityRead>,
  offline: boolean
): BotAutomationDeletion {
  const t = useTranslate()
  const key = botRefKey(bot)
  const { read, currentRead, refresh, refreshSettled } = activity
  const [stored, setState] = useState(() => emptyDeleteState(key))
  const state = stored.key === key ? stored : emptyDeleteState(key)
  if (state !== stored) {
    setState(state)
  }
  const { generation } = state
  // Admission is synchronous: two Deletes in one tick admit one.
  const ops = useRef(new Map<string, DeleteOp>())
  const nextOpId = useRef(0)
  const liveVisit = useRef<{ generation: symbol; signal: AbortSignal } | null>(null)
  const offlineNow = useRef(offline)
  const toldExpired = useRef(new WeakSet<BotAutomationHide>())
  const [tick, setTick] = useState(0)

  useLayoutEffect(() => {
    offlineNow.current = offline
  }, [offline])
  useLayoutEffect(() => {
    const owner = new AbortController()
    liveVisit.current = { generation, signal: owner.signal }
    ops.current = new Map()
    return () => {
      liveVisit.current = null
      owner.abort()
    }
  }, [generation])

  const update = (expected: symbol, change: (state: DeleteState) => DeleteState): void =>
    setState((previous) => (previous.generation === expected ? change(previous) : previous))
  const mirrorOps = (expected: symbol): void => {
    const snapshot = new Map(ops.current)
    update(expected, (previous) => ({ ...previous, ops: snapshot }))
  }

  const run = async (
    op: DeleteOp,
    signal: AbortSignal,
    troubleClearedBy?: CheckFoldedTrouble
  ): Promise<BotAutomationDeleteOutcome> => {
    const alive = (): boolean => !signal.aborted && ops.current.get(op.opKey)?.opId === op.opId
    try {
      await deleteBotAutomation(bot, op.id, op.authority)
    } catch (error) {
      console.error('Failed to delete the automation:', error)
      if (!alive()) {
        return 'uncertain'
      }
      const settled = await reconcileBotAutomationDelete(
        error,
        op.authority,
        refreshSettled,
        signal
      )
      if (!alive()) {
        return 'uncertain'
      }
      const sameRead = settled.ok && sameBotReadAuthority(settled.value.authority, op.authority)
      if (
        sameRead &&
        !settled.value.activity.automations.some((row) => row.automation.id === op.id)
      ) {
        return 'omitted'
      }
      toast.error(t('bots.automations.deleteFailed', 'Couldn’t delete {{name}}', { name: op.name }))
      return sameRead && troubleClearedBy?.(settled.value.activity)
        ? 'trouble-cleared'
        : 'uncertain'
    }
    if (!alive()) {
      return 'uncertain'
    }
    const authority = botReadAuthorityKey(op.authority)
    const hide: BotAutomationHide = {
      authority,
      id: op.id,
      name: op.name,
      expiresAt: Date.now() + AUTOMATION_HIDE_TTL_MS
    }
    update(op.generation, (previous) => ({
      ...previous,
      hides: [...previous.hides.filter((h) => h.authority !== authority || h.id !== op.id), hide]
    }))
    refresh()
    return 'hidden'
  }

  const listed = useMemo(
    () => new Set(read?.activity.automations.map((row) => row.automation.id)),
    [read]
  )
  const currentReadFor = (intent: BotAutomationDeleteRoute): BotActivityWithAuthority | null => {
    const latest = currentRead()
    if (
      intent.generation !== liveVisit.current?.generation ||
      intent.botKey !== key ||
      !latest ||
      botReadAuthorityKey(latest.authority) !== botReadAuthorityKey(intent.authority)
    ) {
      return null
    }
    return latest
  }
  const membership = (intent: BotAutomationDeleteRoute): DeleteMembership => {
    const latest = currentReadFor(intent)
    if (!latest) {
      return 'stale'
    }
    const present =
      latest === read
        ? listed.has(intent.id)
        : latest.activity.automations.some((row) => row.automation.id === intent.id)
    return present ? 'listed' : 'absent'
  }
  const ownsFocus = (intent: BotAutomationDeleteIntent): boolean =>
    membership(intent) !== 'stale' &&
    (intent.authority.kind !== 'environment' ||
      getRuntimeEnvironmentRevision(intent.authority.environmentId) ===
        intent.authority.pairingRevision)
  // A read whose pairing was unknown when sent is shown, but authorizes no delete.
  const canAdmit = (intent: BotAutomationDeleteRoute): boolean =>
    !offlineNow.current &&
    intent.authority.kind !== 'environment-unavailable' &&
    membership(intent) === 'listed' &&
    !ops.current.has(deleteOpKey(intent))

  const admit = (
    intent: BotAutomationDeleteIntent,
    troubleClearedBy?: CheckFoldedTrouble
  ): BotAutomationDeleteAdmission | null => {
    const visit = liveVisit.current
    if (!visit || !canAdmit(intent)) {
      return null
    }
    const opKey = deleteOpKey(intent)
    const op: DeleteOp = { ...intent, opId: ++nextOpId.current, opKey }
    ops.current.set(opKey, op)
    mirrorOps(op.generation)
    const settled = run(op, visit.signal, troubleClearedBy).finally(() => {
      if (!visit.signal.aborted && ops.current.get(op.opKey)?.opId === op.opId) {
        ops.current.delete(op.opKey)
        mirrorOps(op.generation)
      }
    })
    return { opId: op.opId, settled }
  }

  // Each read prunes the hides it settles; one timer re-checks the soonest still listed.
  const hides = state.hides
  useEffect(() => {
    if (!read || hides.length === 0) {
      return
    }
    const { kept, expired } = pruneAutomationHides(hides, read.authority, listed, Date.now())
    for (const hide of expired) {
      if (!toldExpired.current.has(hide)) {
        toldExpired.current.add(hide)
        toast.error(
          t('bots.automations.deleteFailed', 'Couldn’t delete {{name}}', { name: hide.name })
        )
      }
    }
    if (kept !== hides) {
      update(generation, (previous) =>
        previous.hides === hides ? { ...previous, hides: kept } : previous
      )
      return
    }
    const soonest = nextAutomationHideExpiry(kept)
    if (soonest === null) {
      return
    }
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, soonest - Date.now()))
    return () => clearTimeout(timer)
  }, [read, hides, listed, generation, tick, t])

  const authority = read?.authority ?? null
  const hidden = useMemo(() => hiddenAutomationIds(hides, authority), [hides, authority])
  const authorityKey = authority ? botReadAuthorityKey(authority) : null
  const pending = useMemo(() => {
    const byId = new Map<string, BotAutomationPending>()
    for (const op of state.ops.values()) {
      if (botReadAuthorityKey(op.authority) === authorityKey) {
        byId.set(op.id, { opId: op.opId, admittedAsTrouble: op.admittedAsTrouble })
      }
    }
    return byId
  }, [state.ops, authorityKey])

  return {
    authority,
    botKey: key,
    generation,
    hidden,
    pending,
    offline,
    currentReadFor,
    membership,
    ownsFocus,
    canAdmit,
    admit
  }
}

function deleteOpKey(intent: BotAutomationDeleteRoute): string {
  return `${botReadAuthorityKey(intent.authority)}\u0000${intent.id}`
}
