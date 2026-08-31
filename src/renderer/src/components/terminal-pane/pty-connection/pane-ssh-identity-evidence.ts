import { useAppStore } from '@/store'
import { registerPtyIdentityEvidenceHandler } from '../pty-dispatcher'
import { recognizeAgentProcess } from '../../../../../shared/agent-process-recognition'
import { parseAppSshPtyId } from '../../../../../shared/ssh-pty-id'
import { ptyIdentityEvidenceStore } from '@/lib/pty-identity-evidence-store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindPaneSshIdentityEvidence(
  session: ConnectPanePtySession
): (ptyId: string, incarnationId?: string) => (() => void) | null {
  let dispose: (() => void) | null = null
  let epoch = -1
  let providerGeneration = -1
  return (ptyId, incarnationId) => {
    dispose?.()
    const parsed = parseAppSshPtyId(ptyId)
    // Older preload bridges do not expose identity pushes; keep SSH panes
    // usable without trying to initialize the PTY dispatcher on those clients.
    if (!parsed || typeof window.api?.pty?.onIdentityEvidence !== 'function') {
      return null
    }
    dispose = registerPtyIdentityEvidenceHandler(ptyId, (notification) => {
      const incomingProviderGeneration = notification.providerGeneration ?? 0
      if (incomingProviderGeneration < providerGeneration) {
        return
      }
      if (incomingProviderGeneration > providerGeneration) {
        providerGeneration = incomingProviderGeneration
        epoch = -1
        ptyIdentityEvidenceStore.activateGeneration(
          parsed.connectionId,
          notification.authorityGeneration
        )
      }
      if (notification.observationEpoch <= epoch) {
        return
      }
      const row = notification.rows.find((candidate) => candidate.id === ptyId)
      if (!row) {
        return
      }
      if (incarnationId && row.incarnationId !== incarnationId) {
        return
      }
      epoch = notification.observationEpoch
      ptyIdentityEvidenceStore.applyPush({
        hostId: parsed.connectionId,
        ptyId,
        incarnationId: row.incarnationId,
        authorityGeneration: notification.authorityGeneration,
        observationEpoch: notification.observationEpoch,
        evidence: row.foregroundProcessEvidence
      })
      const evidence = row.foregroundProcessEvidence
      if (evidence.verdict === 'live') {
        const recognized = evidence.processName ? recognizeAgentProcess(evidence.processName) : null
        useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
          agent: recognized?.agent ?? null,
          shellForeground: false,
          routingTrusted: recognized !== null
        })
      } else {
        const current = useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey]
        useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
          agent: current?.agent ?? null,
          shellForeground: current?.shellForeground ?? false,
          routingTrusted: false
        })
      }
    })
    return dispose
  }
}
