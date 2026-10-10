import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { codexMaintenanceTargetKey, type CodexMaintenanceTarget } from './codex-maintenance-client'
import {
  subscribeCodexMaintenanceHostContact,
  codexMaintenanceHostIsReachable
} from './codex-maintenance-host-contact'
import {
  getCodexMaintenanceEntry,
  invalidateCodexMaintenanceContact,
  refreshCodexMaintenance,
  subscribeCodexMaintenance
} from './codex-maintenance-store'

const observations = new Map<string, { count: number; dispose: () => void }>()

function sameEnvironment(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  if (left === right) {
    return true
  }
  const keys = Object.keys(left ?? {})
  return (
    keys.length === Object.keys(right ?? {}).length &&
    keys.every((key) => left?.[key] === right?.[key])
  )
}

function sameConfiguration(left: GlobalSettings | null, right: GlobalSettings | null): boolean {
  if (left === right) {
    return true
  }
  return (
    left?.activeRuntimeEnvironmentId === right?.activeRuntimeEnvironmentId &&
    left?.agentCmdOverrides?.codex === right?.agentCmdOverrides?.codex &&
    sameEnvironment(left?.agentDefaultEnv?.codex, right?.agentDefaultEnv?.codex) &&
    left?.nativeChatInheritShellEnvironment === right?.nativeChatInheritShellEnvironment &&
    (left?.nativeChatShellEnvironmentVariables ?? []).length ===
      (right?.nativeChatShellEnvironmentVariables ?? []).length &&
    (left?.nativeChatShellEnvironmentVariables ?? []).every(
      (value, index) => value === right?.nativeChatShellEnvironmentVariables?.[index]
    )
  )
}

export function observeCodexMaintenance(target: CodexMaintenanceTarget): () => void {
  const key = codexMaintenanceTargetKey(target)
  let observation = observations.get(key)
  if (!observation) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let evidence: unknown
    const schedule = (): void => {
      const entry = getCodexMaintenanceEntry(key)
      const current = entry.verification === 'current' ? entry.state?.evidence : undefined
      if (current === evidence) {
        return
      }
      evidence = current
      clearTimeout(timer)
      timer = undefined
      if (!current) {
        return
      }
      timer = setTimeout(
        () => {
          invalidateCodexMaintenanceContact(target)
          if (codexMaintenanceHostIsReachable(target)) {
            void refreshCodexMaintenance(target)
          }
        },
        Math.max(0, entry.expiresAt - Date.now())
      )
    }
    const unsubscribeStore = subscribeCodexMaintenance(schedule)
    const unsubscribeContact = subscribeCodexMaintenanceHostContact(target)
    const unsubscribeSettings = useAppStore.subscribe((state, previous) => {
      if (sameConfiguration(state.settings, previous.settings)) {
        return
      }
      invalidateCodexMaintenanceContact(target)
      if (codexMaintenanceHostIsReachable(target)) {
        void refreshCodexMaintenance(target)
      }
    })
    observation = {
      count: 0,
      dispose: () => {
        clearTimeout(timer)
        unsubscribeStore()
        unsubscribeSettings()
        unsubscribeContact()
      }
    }
    observations.set(key, observation)
    schedule()
  }
  observation.count += 1
  return () => {
    if (--observation.count === 0) {
      observation.dispose()
      observations.delete(key)
    }
  }
}
