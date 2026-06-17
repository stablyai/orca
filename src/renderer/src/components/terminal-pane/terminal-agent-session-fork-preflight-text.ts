import { translate } from '@/i18n/i18n'
import type {
  RuntimeAgentSessionForkNativeProviderReason,
  RuntimeAgentSessionForkPreflightResult
} from '../../../../shared/runtime-types'

export type PreflightState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: RuntimeAgentSessionForkPreflightResult }
  | { status: 'error'; message: string }

function formatNativeProviderReason(reason: RuntimeAgentSessionForkNativeProviderReason): string {
  switch (reason) {
    case 'provider-session-metadata-unavailable':
      return translate(
        'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightReasonMetadataUnavailable',
        'provider session metadata is unavailable'
      )
    case 'provider-native-fork-unsupported':
      return translate(
        'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightReasonUnsupported',
        'the source agent does not support native forking'
      )
    case 'provider-native-fork-plan-unavailable':
      return translate(
        'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightReasonPlanUnavailable',
        'a native fork startup plan could not be built'
      )
    case 'message-fork-point-selected':
      return translate(
        'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightReasonMessageForkPoint',
        'a message fork point was selected'
      )
  }
}

export function getPreflightDescription(args: {
  preflight: PreflightState
  usesRuntimeForkService: boolean
}): string {
  if (!args.usesRuntimeForkService) {
    return translate(
      'auto.components.terminal.pane.TerminalAgentSessionForkDialog.transcriptOnlyContextDelivery',
      'A runtime terminal handle is not available, so this fork uses the captured transcript fallback.'
    )
  }
  if (args.preflight.status === 'loading') {
    return translate(
      'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightLoading',
      'Checking context delivery...'
    )
  }
  if (args.preflight.status === 'error') {
    return translate(
      'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightError',
      'Could not check context delivery. Orca will re-check when creating the fork.'
    )
  }
  if (args.preflight.status === 'ready') {
    const delivery = args.preflight.result.contextDelivery
    if (delivery.mode === 'native-provider') {
      return translate(
        'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightNativeProvider',
        'Provider-native fork available for {{agent}}.'
      ).replace('{{agent}}', delivery.agent)
    }
    if (delivery.mode === 'structured-message-fallback') {
      const promptLabel = delivery.includedPromptCount === 1 ? 'prompt' : 'prompts'
      return translate(
        'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightStructuredMessageFallback',
        'Message fork planned at {{message}} with {{count}} structured {{promptLabel}}. Native fork unavailable: {{reason}}.'
      )
        .replace('{{message}}', delivery.forkPoint.id)
        .replace('{{count}}', String(delivery.includedPromptCount))
        .replace('{{promptLabel}}', promptLabel)
        .replace('{{reason}}', formatNativeProviderReason(delivery.nativeProviderReason))
    }
    if (delivery.mode === 'structured-history-fallback') {
      const promptLabel = delivery.includedPromptCount === 1 ? 'prompt' : 'prompts'
      return translate(
        'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightStructuredHistoryFallback',
        'Structured history fallback planned with {{count}} recorded {{promptLabel}}. Native fork unavailable: {{reason}}.'
      )
        .replace('{{count}}', String(delivery.includedPromptCount))
        .replace('{{promptLabel}}', promptLabel)
        .replace('{{reason}}', formatNativeProviderReason(delivery.nativeProviderReason))
    }
    const lineLabel = delivery.transcriptLineCount === 1 ? 'line' : 'lines'
    const truncation = delivery.transcriptTruncated
      ? translate(
          'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightTranscriptTruncated',
          ', truncated to the newest output'
        )
      : ''
    return translate(
      'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightTranscriptFallback',
      'Transcript fallback planned: {{count}} terminal {{lineLabel}}{{truncation}}. Native fork unavailable: {{reason}}.'
    )
      .replace('{{count}}', String(delivery.transcriptLineCount))
      .replace('{{lineLabel}}', lineLabel)
      .replace('{{truncation}}', truncation)
      .replace('{{reason}}', formatNativeProviderReason(delivery.nativeProviderReason))
  }
  return translate(
    'auto.components.terminal.pane.TerminalAgentSessionForkDialog.runtimeContextDelivery',
    'Orca will request a provider-native fork when the source agent supports it. Otherwise it uses a transcript fallback from this terminal.'
  )
}
