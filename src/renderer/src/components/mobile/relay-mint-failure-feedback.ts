import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'

type RelayMintFailureFeedbackArgs = {
  failure: MobileRelayMintFailure
  preferredConnectionMode: string
}

// Why: users share this payload — the selected address would leak a LAN/Tailscale IP or hostname.
export function buildRelayMintFailureFeedback(args: RelayMintFailureFeedbackArgs): string {
  return [
    'Mobile pairing could not attach Orca Relay.',
    '',
    JSON.stringify(
      {
        kind: 'mobile_pairing_relay_failure',
        preferredConnectionMode: args.preferredConnectionMode,
        failure: args.failure,
        at: new Date().toISOString()
      },
      null,
      2
    )
  ].join('\n')
}

export type RelayMintFailureFeedbackSender = {
  send: (args: RelayMintFailureFeedbackArgs) => Promise<void>
  /** Why: main allows the submit 10s, so the button must show progress or users re-click. */
  sending: boolean
}

/** Why: without a direct send, users pasted these diagnostics into the crash dialog. */
export function useSendRelayMintFailureFeedback(): RelayMintFailureFeedbackSender {
  // Why: a `gh` subprocess plus an HTTPS post, so repeat clicks would file duplicate
  // reports and queue extra spawns behind the shared gh concurrency limit. The ref
  // rejects clicks landing before React has flushed `sending` to the disabled button.
  const inFlightRef = useRef(false)
  const [sending, setSending] = useState(false)

  const send = useCallback(async (args: RelayMintFailureFeedbackArgs): Promise<void> => {
    if (inFlightRef.current) {
      return
    }
    inFlightRef.current = true
    setSending(true)
    try {
      // Why: identity is best-effort; a missing gh session must not block the report.
      const viewer = await window.api.gh.viewer().catch(() => null)
      const result = await window.api.feedback.submit({
        feedback: buildRelayMintFailureFeedback(args),
        submitAnonymously: !viewer,
        githubLogin: viewer?.login ?? null,
        githubEmail: null
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      toast.success(
        translate(
          'auto.components.mobile.MobileRelayMintFailureNotice.diagnosticsSent',
          'Diagnostics sent to Orca'
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.mobile.MobileRelayMintFailureNotice.diagnosticsSendFailed',
          'Failed to send diagnostics'
        )
      )
      console.error('Failed to send relay pairing diagnostics:', error)
    } finally {
      inFlightRef.current = false
      setSending(false)
    }
  }, [])

  return { send, sending }
}
