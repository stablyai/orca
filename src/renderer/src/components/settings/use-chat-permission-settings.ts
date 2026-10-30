import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { useStructuredAgentSessionOwnPermissionState } from '@/runtime/structured-agent-session-host-capability'
import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'
import {
  readHostAgentLaunchSettings,
  subscribeHostAgentLaunchSettings
} from './agent-launch-settings-transport'

export function useChatPermissionSettings(settings: GlobalSettings) {
  const web = isWebClientLocation()
  // The web preload exposes only its active paired environment in this catalog.
  const environment = useAppStore((state) => (web ? state.runtimeEnvironments[0] : undefined))
  const environmentId = environment?.id
  const pairingRevision = environment?.pairingRevision ?? environment?.createdAt
  const runtimeId = environment?.runtimeId ?? undefined
  const capability = useStructuredAgentSessionOwnPermissionState(
    web ? (environmentId ? { kind: 'environment', environmentId } : null) : { kind: 'local' }
  )
  const key = JSON.stringify([environmentId, pairingRevision, runtimeId])
  const [answer, setAnswer] = useState<{
    key: string
    settings: AgentLaunchSettings | null
  } | null>(null)
  useEffect(() => {
    if (!environmentId || capability !== 'supported') {
      return
    }
    const owner = { environmentId, pairingRevision, runtimeId }
    let controller = new AbortController()
    const refresh = (): void => {
      controller.abort()
      const readController = new AbortController()
      controller = readController
      void readHostAgentLaunchSettings(owner, readController.signal).then(
        (value) => {
          if (!readController.signal.aborted) {
            setAnswer({ key, settings: value })
          }
        },
        () => {
          if (!readController.signal.aborted) {
            setAnswer({ key, settings: null })
          }
        }
      )
    }
    const unsubscribe = subscribeHostAgentLaunchSettings((changedOwner) => {
      if (
        changedOwner.environmentId === environmentId &&
        changedOwner.pairingRevision === pairingRevision
      ) {
        refresh()
      }
    })
    const disconnect = subscribeRuntimeHostContactRegained(environmentId, refresh)
    refresh()
    return () => {
      controller.abort()
      unsubscribe()
      disconnect()
    }
  }, [capability, environmentId, pairingRevision, runtimeId, key])
  const permission = answer?.key === key ? answer.settings?.agentPermission : null
  return {
    capability,
    settings: web
      ? permission
        ? {
            agentPermissionDefault: permission.default,
            agentPermissionOverrides: permission.overrides
          }
        : null
      : settings
  }
}
