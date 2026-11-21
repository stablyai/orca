import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { sayNativeChatOrcaStopTranslated } from '@/components/native-chat/messages/notices/native-chat-orca-stop-words-text'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '../../../../store/index'

/** Return the host’s display name, or null for unnamed paired servers; raw IDs are not names. */
export function useStructuredAgentSessionHostLabel(target: RuntimeClientTarget): string | null {
  const t = useTranslate()
  return useAppStore((state) => {
    const label = selectExecutionHostDisplayLabel(
      state,
      executionHostIdForStructuredTarget(target),
      { t }
    )
    return target.kind === 'environment' && label === target.environmentId ? null : label
  })
}

/** Where a sentence says something runs: "this computer", or the server's name. */
export function structuredAgentSessionHostPlace(
  remoteHost: boolean,
  hostLabel: string | null,
  t: Translate
): string {
  return remoteHost
    ? (hostLabel ?? sayNativeChatOrcaStopTranslated('unnamedServer'))
    : t('components.native-chat.receipt.thisComputer', 'this computer')
}

export function useStructuredAgentSessionHostPlace(target: RuntimeClientTarget): string {
  const t = useTranslate()
  const hostLabel = useStructuredAgentSessionHostLabel(target)
  return structuredAgentSessionHostPlace(target.kind === 'environment', hostLabel, t)
}
