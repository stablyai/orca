import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isLegacyAgentSessionAccountHome } from '../../../../shared/agent-session-account-home'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'

export type SessionAccountSource = Pick<
  AiVaultSession,
  'agent' | 'executionHostId' | 'accountHome' | 'accountWslDistro'
>
export type NativeAccountBinding = { kind: 'claude' | 'codex'; scope: string; path: string }
export type AccountBinding = NativeAccountBinding | { kind: 'opencode'; id: string }
export type SessionAccountBinding =
  | { key: string; binding: AccountBinding }
  | { value: string | null }

export function accountRuntimeScope(runtime?: 'host' | 'wsl', distro?: string | null): string {
  return runtime === 'wsl' ? `wsl:${distro?.toLowerCase() ?? ''}` : 'host'
}

export function sessionAccountBinding(session: SessionAccountSource): SessionAccountBinding {
  if (session.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return { value: null }
  }
  const home = session.accountHome
  const defaultValue = () =>
    translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')
  if (home === null) {
    return { value: defaultValue() }
  }
  if (!home) {
    return { value: null }
  }
  if (!isLegacyAgentSessionAccountHome(home)) {
    if (home.locator.kind === 'unmanaged') {
      return { value: defaultValue() }
    }
    const binding = { kind: 'opencode' as const, id: home.locator.managedProfileId }
    return { key: JSON.stringify([session.agent, session.executionHostId, binding]), binding }
  }
  if (
    (session.agent === 'claude' && home.variable === 'CLAUDE_CONFIG_DIR') ||
    (session.agent === 'codex' && home.variable === 'CODEX_HOME')
  ) {
    const binding: NativeAccountBinding = {
      kind: session.agent,
      scope: accountRuntimeScope(
        session.accountWslDistro ? 'wsl' : 'host',
        session.accountWslDistro
      ),
      path: normalizeRuntimePathForComparison(home.path)
    }
    return { key: JSON.stringify([session.agent, session.executionHostId, binding]), binding }
  }
  return { value: null }
}
