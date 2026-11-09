// Sender metadata for agents in shared (team-visible) Orca Cloud workspaces: several org members can
// drive the same agent, so each message names who sent it (see shared/cloud-workspaces/sender-envelope).
// This module tracks which runtime environments are shared cloud workspaces and who "I" am.
import { useAppStore } from '@/store'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import {
  withSenderEnvelope,
  type MessageSender
} from '../../../shared/cloud-workspaces/sender-envelope'

const REFRESH_MS = 60_000
let sharedEnvironments = new Set<string>()

/** Me, as teammates' agents should see me; null when not signed into an org. */
function currentSender(): MessageSender | null {
  const cloud = useAppStore.getState().orcaProfileAuthStatus?.cloud
  if (!cloud?.userId || !cloud.activeOrgId) {
    return null
  }
  return { userId: cloud.userId, name: cloud.displayName || cloud.email }
}

export function cloudSenderForEnvironment(environmentId: string): MessageSender | null {
  return sharedEnvironments.has(environmentId) ? currentSender() : null
}

/** Prefixes the first text block of a structured message with the sender line (shared workspaces only). */
export function withCloudSenderBody<T extends { blocks: readonly { type: string }[] }>(
  environmentId: string,
  body: T
): T {
  const sender = cloudSenderForEnvironment(environmentId)
  if (!sender) {
    return body
  }
  let done = false
  const blocks = body.blocks.map((block) => {
    if (done || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') {
      return block
    }
    done = true
    return { ...block, text: withSenderEnvelope(block.text, sender) }
  })
  return done ? { ...body, blocks } : body
}

/** Re-reads which environments are shared; call after pairing or a visibility change. */
export async function refreshCloudMessageSenders(): Promise<void> {
  const api = window.api.cloudWorkspaces
  if (!api || !currentSender() || !(await api.available().catch(() => false))) {
    sharedEnvironments = new Set()
    return
  }
  const [list, local, bindings] = await Promise.all([
    api.list({ scope: 'team' }),
    api.localWorkspaces(),
    api.environmentBindings()
  ])
  if (!list.ok) {
    return
  }
  const team = new Set(list.value.filter((w) => w.visibility === 'team').map((w) => w.id))
  const next = new Set<string>()
  for (const l of local) {
    if (team.has(l.sandboxId) && l.runtimeEnvironmentId) {
      next.add(l.runtimeEnvironmentId)
    }
  }
  for (const [sandboxId, binding] of Object.entries(bindings)) {
    if (team.has(sandboxId) && binding.environmentId) {
      next.add(binding.environmentId)
    }
  }
  sharedEnvironments = next
}

export function installCloudMessageSender(): () => void {
  void refreshCloudMessageSenders().catch(() => undefined)
  // Re-reads while the window is visible (and on becoming visible); hidden windows send nothing.
  const stopInterval = installWindowVisibilityInterval({
    run: () => void refreshCloudMessageSenders().catch(() => undefined),
    intervalMs: REFRESH_MS
  })
  const onFocus = (): void => void refreshCloudMessageSenders().catch(() => undefined)
  window.addEventListener('focus', onFocus)
  return () => {
    stopInterval()
    window.removeEventListener('focus', onFocus)
  }
}
