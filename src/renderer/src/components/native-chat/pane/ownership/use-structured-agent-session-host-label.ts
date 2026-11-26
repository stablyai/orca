import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { sayNativeChatOrcaStopTranslated } from '@/components/native-chat/messages/notices/native-chat-orca-stop-words-text'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '../../../../store/index'
import type { AppState } from '../../../../store/types'

/** Return the host’s display name, or null for unnamed paired servers; raw IDs are not names. */
export function structuredAgentSessionHostLabel(
  state: AppState,
  target: RuntimeClientTarget,
  t: Translate
): string | null {
  const label = selectExecutionHostDisplayLabel(state, executionHostIdForStructuredTarget(target), {
    t
  })
  return target.kind === 'environment' && label === target.environmentId ? null : label
}

export function useStructuredAgentSessionHostLabel(target: RuntimeClientTarget): string | null {
  const t = useTranslate()
  return useAppStore((state) => structuredAgentSessionHostLabel(state, target, t))
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

/** Where something on `target` runs, read once from the store. */
export function structuredAgentSessionTargetPlace(
  state: AppState,
  target: RuntimeClientTarget,
  t: Translate
): string {
  return structuredAgentSessionHostPlace(
    target.kind === 'environment',
    structuredAgentSessionHostLabel(state, target, t),
    t
  )
}

export function useStructuredAgentSessionHostPlace(target: RuntimeClientTarget): string {
  const t = useTranslate()
  return useAppStore((state) => structuredAgentSessionTargetPlace(state, target, t))
}
