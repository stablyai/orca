// Sender metadata for agents in shared (team-visible) Orca Cloud workspaces: several org members can
// drive the same agent, so each message names who sent it (see shared/cloud-workspaces/sender-envelope).
// This module tracks which runtime environments are shared cloud workspaces and who "I" am.
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import {
  withSenderEnvelope,
  type MessageSender
} from '../../../shared/cloud-workspaces/sender-envelope'

const REFRESH_MS = 60_000
let sharedEnvironments = new Set<string>()
/** Every cloud workspace environment this desktop uses (own or teammate's) → its sandbox id. */
let cloudSandboxByEnvironment = new Map<string, string>()
const SEND_REPORT_MIN_MS = 30_000
const lastSendReport = new Map<string, number>()

/**
 * Tells the control plane "I just sent a message in this workspace" with my own Orca token: git as
 * the sender works for me only for a while after this, so nothing in the sandbox can push as me
 * when I am not driving it. Throttled; best effort.
 */
export function noteCloudSend(environmentId: string, now: number = Date.now()): void {
  const sandboxId = cloudSandboxByEnvironment.get(environmentId)
  if (!sandboxId || now - (lastSendReport.get(sandboxId) ?? 0) < SEND_REPORT_MIN_MS) {
    return
  }
  lastSendReport.set(sandboxId, now)
  void window.api.cloudWorkspaces?.noteSent(sandboxId).catch(() => undefined)
}

/** The signed-in cloud identity fields the sender line needs. */
export type CloudSenderIdentity = {
  userId?: string | null
  activeOrgId?: string | null
  displayName?: string | null
  email?: string | null
}

// Injected at install (cloud-message-sender-install.ts) so this module never imports the store:
// the store's own delivery path imports this module.
let readCloudIdentity: () => CloudSenderIdentity | null | undefined = () => null

/** Me, as teammates' agents should see me; null when not signed into an org. */
function currentSender(): MessageSender | null {
  const cloud = readCloudIdentity()
  if (!cloud?.userId || !cloud.activeOrgId) {
    return null
  }
  return { userId: cloud.userId, name: cloud.displayName || cloud.email || '' }
}

export function cloudSenderForEnvironment(environmentId: string): MessageSender | null {
  return sharedEnvironments.has(environmentId) ? currentSender() : null
}

/** Prefixes the first text block of a structured message with the sender line (shared workspaces only). */
export function withCloudSenderBody<T extends { blocks: readonly { type: string }[] }>(
  environmentId: string,
  body: T
): T {
  noteCloudSend(environmentId)
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
  const byEnvironment = new Map<string, string>()
  for (const l of local) {
    if (l.runtimeEnvironmentId) {
      byEnvironment.set(l.runtimeEnvironmentId, l.sandboxId)
      if (team.has(l.sandboxId)) {
        next.add(l.runtimeEnvironmentId)
      }
    }
  }
  for (const [sandboxId, binding] of Object.entries(bindings)) {
    if (binding.environmentId) {
      byEnvironment.set(binding.environmentId, sandboxId)
      if (team.has(sandboxId)) {
        next.add(binding.environmentId)
      }
    }
  }
  sharedEnvironments = next
  cloudSandboxByEnvironment = byEnvironment
}

export function installCloudMessageSender(
  readIdentity: () => CloudSenderIdentity | null | undefined
): () => void {
  readCloudIdentity = readIdentity
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
