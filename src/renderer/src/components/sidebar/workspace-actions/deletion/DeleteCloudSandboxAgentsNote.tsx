import type React from 'react'
import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { resolveWorktreeRowOpenInRuntimeOwner } from '@/lib/workspace/ownership/worktree-row-open-in-owner'
import {
  readHostAgentSignInReport,
  refreshHostAgentSignInReport,
  subscribeHostAgentSignInReports
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { useCloudSshMenuState, type CloudSshWorktree } from '../cloud-ssh/use-cloud-ssh-status'

/**
 * Before deleting a running Orca Cloud sandbox the control plane runs each agent's sign-out.
 * Only a CLI login saved on the sandbox (the kill-switch fallback) has anything to sign out; the
 * usual Orca-account placeholders report as API keys, so the line stays hidden for them.
 */
export function DeleteCloudSandboxAgentsNote({
  worktree
}: {
  worktree: CloudSshWorktree
}): React.JSX.Element | null {
  const t = useTranslate()
  const state = useCloudSshMenuState(worktree)
  const running = state.kind === 'ready' && state.status.running === true
  const environmentId = useAppStore(
    (s) => resolveWorktreeRowOpenInRuntimeOwner(s, worktree).runtimeEnvironmentId ?? null
  )
  const report = useSyncExternalStore(subscribeHostAgentSignInReports, () =>
    environmentId ? readHostAgentSignInReport(environmentId) : null
  )
  useEffect(() => {
    // Asked only while running: an asleep sandbox is never woken to probe.
    if (running && environmentId) {
      void refreshHostAgentSignInReport(environmentId)
    }
  }, [running, environmentId])
  const holdsLogin = (report?.agents ?? []).some(
    (entry) => entry.state === 'signedIn' && entry.method !== 'apiKey'
  )
  if (!running || !holdsLogin) {
    return null
  }
  return (
    <p className="text-[12.5px] text-muted-foreground">
      {t(
        'auto.components.sidebar.DeleteWorktreeDialog.cloudSignsAgentsOut',
        'Signs agents out on the sandbox first.'
      )}
    </p>
  )
}
