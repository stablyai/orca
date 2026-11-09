// Terminal agents in a shared (team-visible) Orca Cloud workspace hear from several teammates, so a
// chat message typed into their PTY starts with the same one-line sender envelope structured sends
// carry. The terminal transcript shows the line as typed; only native chat rows can strip it.
import { cloudSenderForEnvironment } from '@/lib/cloud-message-sender'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import {
  withSenderEnvelope,
  type MessageSender
} from '../../../../../../../shared/cloud-workspaces/sender-envelope'

export type PtyCloudSenderDeps = {
  environmentOf: (ptyId: string) => string | null
  senderFor: (environmentId: string) => MessageSender | null
}

const DEFAULT_DEPS: PtyCloudSenderDeps = {
  environmentOf: getRemoteRuntimePtyEnvironmentId,
  senderFor: cloudSenderForEnvironment
}

/** The text to type into this PTY: enveloped for a shared cloud workspace, unchanged otherwise. */
export function withPtyCloudSender(
  ptyId: string,
  text: string,
  deps: PtyCloudSenderDeps = DEFAULT_DEPS
): string {
  const environmentId = deps.environmentOf(ptyId)
  const sender = environmentId ? deps.senderFor(environmentId) : null
  return sender ? withSenderEnvelope(text, sender) : text
}
