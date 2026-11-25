import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { subscribeHostAgentLaunchSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import type { AutomationModelRecoverySelection } from '../../../../../shared/automations/history/automation-model-recovery'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import type { BotAgent } from '../../../../../shared/bot-types'
import { readAutomationRecoverySelectionForOwner } from '../hosts/automation-model-recovery-client'

export type AutomationRecoveryModelRead =
  | { status: 'loading' | 'unavailable' }
  | { status: 'refreshing' | 'ready'; selection: AutomationModelRecoverySelection }

function pendingRead(selection?: AutomationModelRecoverySelection): AutomationRecoveryModelRead {
  return selection ? { status: 'refreshing', selection } : { status: 'loading' }
}

/** A Settings model is inherited from the owner, even while the client is on another host. */
export function useAutomationRecoveryModel(
  owner: AutomationOwnerRef | null,
  id: string | undefined,
  runKey: string | null,
  settingsKey: string,
  agent: BotAgent | undefined,
  setupFingerprint: string | undefined
) {
  const current = useRef<AutomationModelRecoverySelection | undefined>(undefined)
  const lookupKey =
    owner && id && runKey && setupFingerprint ? JSON.stringify([runKey, setupFingerprint]) : null
  const [answer, setAnswer] = useState<{
    runKey: string | null
    settingsKey: string
    read: AutomationRecoveryModelRead
  }>({ runKey: lookupKey, settingsKey, read: pendingRead() })
  const sameVisit = answer.runKey === lookupKey
  const read =
    sameVisit && answer.settingsKey === settingsKey
      ? answer.read
      : pendingRead(sameVisit && 'selection' in answer.read ? answer.read.selection : undefined)
  if (!sameVisit || answer.settingsKey !== settingsKey) {
    setAnswer({ runKey: lookupKey, settingsKey, read })
  }
  const lookupOwner = useEffectEvent(() => owner)
  useLayoutEffect(() => {
    const owner = lookupOwner()
    if (!owner || !id || !lookupKey || !agent || !setupFingerprint) {
      return
    }
    let request: object | undefined
    let previous: AutomationModelRecoverySelection | undefined
    const refresh = () => {
      const token = {}
      request = token
      current.current = undefined
      void readAutomationRecoverySelectionForOwner(owner, id, agent, setupFingerprint)
        .catch(() => undefined)
        .then((selection) => {
          if (request !== token) {
            return
          }
          previous = selection
          current.current = selection
          setAnswer({
            runKey: lookupKey,
            settingsKey,
            read: selection ? { status: 'ready', selection } : { status: 'unavailable' }
          })
        })
    }
    refresh()
    const authority = owner.authority
    const unsubscribe =
      authority.kind === 'runtime'
        ? subscribeHostAgentLaunchSettings(({ environmentId }) => {
            if (environmentId === authority.environmentId) {
              refresh()
              setAnswer({ runKey: lookupKey, settingsKey, read: pendingRead(previous) })
            }
          })
        : undefined
    return () => {
      request = undefined
      current.current = undefined
      unsubscribe?.()
    }
  }, [id, lookupKey, settingsKey, agent, setupFingerprint])
  return { read, currentSelection: () => current.current }
}
