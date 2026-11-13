// Drives one S4-b card: the typed value lives only here, is sent once to Orca Cloud (PUT
// /v1/secrets/:scope/:NAME through main), then orcad is told the outcome. The value never goes to orcad.
import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { cloudSecretsErrorCopy } from '@/components/settings/cloud-secrets/cloud-secrets-copy'
import { cloudSecretRepoKey } from '@/components/settings/cloud-secrets/cloud-secret-repos'
import {
  dismissSecretRequest,
  readSecretRequestTouchedAt,
  setSecretRequestExpiry,
  setSecretRequestLocal,
  setSecretRequestTouched,
  type SecretRequestEntry
} from '@/lib/secret-requests/secret-request-store'
import { useAgentHostPanelOpener } from '@/lib/agent-host-panel/agent-host-panel-opener'
import {
  restartableSecretRequestAgent,
  secretRequestAgentName
} from '@/lib/secret-requests/secret-request-routing'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  SECRETS_RESOLVE_REQUEST_METHOD,
  SECRETS_TOUCH_REQUEST_METHOD,
  type SecretRequestScope,
  type SecretsResolveRequestResult,
  type SecretsTouchRequestResult
} from '../../../../shared/secret-request-contract'
import { cloudWorkspaceSecretsMode } from '@/lib/orca-cloud/cloud-workspace-secrets-mode'
import type { CloudSecretsErrorCode } from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import { canWriteRepo } from './secret-request-repo-write'
import type {
  SecretRequestCardActions,
  SecretRequestCardModel,
  SecretRequestCardPhase
} from './SecretRequestCard'

/** D3: while the card has focus or a typed value, keep the request alive, at most once a minute. */
export const SECRET_REQUEST_TOUCH_INTERVAL_MS = 60_000
const RPC_TIMEOUT_MS = 15_000

/** Failures that mean the request never reached Orca Cloud: nothing changed, so retry is safe. */
const TRANSPORT_FAILURES: ReadonlySet<CloudSecretsErrorCode> = new Set([
  'unavailable',
  'timeout',
  'unknown'
])

export { resetSecretRequestCardCachesForTests } from './secret-request-repo-write'

function useWorkspaceRepoKey(worktreeId: string | null): string | null {
  return useAppStore((state) => {
    if (!worktreeId) {
      return null
    }
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const repo = state.repos.find((entry) => entry.id === repoId)
    return repo ? cloudSecretRepoKey(repo) : null
  })
}

async function resolveRequest(
  environmentId: string,
  requestId: string,
  outcome: 'provided' | 'declined'
): Promise<SecretsResolveRequestResult['outcome'] | null> {
  try {
    const result = await callRuntimeRpc<SecretsResolveRequestResult>(
      { kind: 'environment', environmentId },
      SECRETS_RESOLVE_REQUEST_METHOD,
      { requestId, outcome },
      { timeoutMs: RPC_TIMEOUT_MS }
    )
    return result.outcome
  } catch {
    return null
  }
}

export function useSecretRequestCard(args: {
  entry: SecretRequestEntry
  more: number
  worktreeId: string | null
  /** The pane's PTY, for Restart {{agent}}. */
  ptyId: string | null
  /** The card sits on the asking agent's own pane; only then can Restart target it. */
  onAskingPane: boolean
}): { model: SecretRequestCardModel; actions: SecretRequestCardActions } {
  const { entry, more, worktreeId, ptyId, onAskingPane } = args
  const { environmentId, event } = entry
  const { requestId } = event
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<SecretRequestScope>('personal')
  const [failed, setFailed] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [repoWritable, setRepoWritable] = useState(false)
  // SEC-5: a shared workspace gets no Personal secrets, so a Personal save would never reach it.
  // Unknown until read: Personal stays offered meanwhile, as before this check existed.
  const [sharedWorkspace, setSharedWorkspace] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const repoKey = useWorkspaceRepoKey(event.worktreeId ?? worktreeId)
  const openPanel = useAgentHostPanelOpener()
  const local = entry.local

  useEffect(() => {
    let cancelled = false
    if (repoKey) {
      void canWriteRepo(repoKey).then((writable) => {
        if (!cancelled) {
          setRepoWritable(writable)
        }
      })
    }
    return () => {
      cancelled = true
    }
  }, [repoKey])

  useEffect(() => {
    let cancelled = false
    void cloudWorkspaceSecretsMode(environmentId).then((mode) => {
      if (!cancelled) {
        setSharedWorkspace(mode === 'shared')
      }
    })
    return () => {
      cancelled = true
    }
  }, [environmentId])

  // The card's own clock: an open request past its expiry shows as expired and drops what was typed.
  useEffect(() => {
    if (local !== null) {
      return
    }
    const remaining = event.expiresAt - Date.now()
    const expire = (): void => {
      setValue('')
      setSecretRequestLocal(environmentId, requestId, 'expired')
    }
    if (remaining <= 0) {
      expire()
      return
    }
    const timer = window.setTimeout(expire, remaining)
    return () => window.clearTimeout(timer)
  }, [environmentId, requestId, event.expiresAt, local])

  // D3 hold: touch now (if a minute has passed) and every minute while focused or holding a value.
  const holding = (focused || value.length > 0) && local === null
  useEffect(() => {
    if (!holding) {
      return
    }
    const touch = (): void => {
      setSecretRequestTouched(environmentId, requestId, Date.now())
      void callRuntimeRpc<SecretsTouchRequestResult>(
        { kind: 'environment', environmentId },
        SECRETS_TOUCH_REQUEST_METHOD,
        { requestId },
        { timeoutMs: RPC_TIMEOUT_MS }
      ).then(
        (result) => setSecretRequestExpiry(environmentId, requestId, result.expiresAt),
        () => {}
      )
    }
    // Never more than once a minute, across focus changes and card remounts too.
    const delay = Math.max(
      0,
      readSecretRequestTouchedAt(environmentId, requestId) +
        SECRET_REQUEST_TOUCH_INTERVAL_MS -
        Date.now()
    )
    let interval: number | undefined
    const first = window.setTimeout(() => {
      touch()
      interval = window.setInterval(touch, SECRET_REQUEST_TOUCH_INTERVAL_MS)
    }, delay)
    return () => {
      window.clearTimeout(first)
      if (interval !== undefined) {
        window.clearInterval(interval)
      }
    }
  }, [holding, environmentId, requestId])

  const repoScope = repoKey !== null && repoWritable
  const scopes: SecretRequestScope[] = sharedWorkspace
    ? repoScope
      ? ['repo']
      : []
    : repoScope
      ? ['personal', 'repo']
      : ['personal']
  const effectiveScope: SecretRequestScope = scopes.includes(scope)
    ? scope
    : (scopes[0] ?? 'personal')

  const add = useCallback(async () => {
    const api = window.api.cloudSecrets
    if (!value || local !== null || scopes.length === 0) {
      return
    }
    setFailed(false)
    setFieldError(null)
    if (!api) {
      setFailed(true)
      return
    }
    setSecretRequestLocal(environmentId, requestId, 'saving')
    const target =
      effectiveScope === 'repo' && repoKey
        ? { scope: 'repo' as const, repo: repoKey }
        : { scope: 'personal' as const }
    const result = await api.put({ target, name: event.name, value }).catch(() => null)
    if (!result || !result.ok) {
      const code: CloudSecretsErrorCode = result?.ok === false ? result.error : 'unknown'
      setSecretRequestLocal(environmentId, requestId, null)
      if (TRANSPORT_FAILURES.has(code)) {
        setFailed(true)
      } else {
        setFieldError(cloudSecretsErrorCopy(code, t))
      }
      return
    }
    // Saved: the value is gone from the renderer from here on.
    setValue('')
    void api.refreshEnv({ runtimeEnvironmentId: environmentId }).catch(() => {})
    const outcome = await resolveRequest(environmentId, requestId, 'provided')
    // Only a confirmed 'provided' means the agent was told; otherwise say so and let the person tell it.
    setSecretRequestLocal(
      environmentId,
      requestId,
      outcome === 'provided' ? 'saved' : 'savedAfterExpiry'
    )
  }, [
    value,
    local,
    scopes.length,
    environmentId,
    requestId,
    effectiveScope,
    repoKey,
    event.name,
    t
  ])

  const phase: SecretRequestCardPhase =
    local === 'saving'
      ? 'saving'
      : local === 'saved' || local === 'savedAfterExpiry' || local === 'expired'
        ? local
        : failed
          ? 'failed'
          : 'open'

  const agent = secretRequestAgentName(event.agent)
  const restartAgent = restartableSecretRequestAgent(event.agent)

  return {
    model: {
      agent,
      name: event.name,
      reason: event.reason ?? null,
      suggestedRepo: event.scope === 'repo',
      scopes,
      scope: effectiveScope,
      sharedWorkspace,
      // An expired request shows no field, and what was typed doesn't come back.
      value: local === 'expired' ? '' : value,
      phase,
      fieldError,
      more,
      canRestart: restartAgent !== null && ptyId !== null && onAskingPane,
      collapsed
    },
    actions: {
      onValueChange: (next) => {
        setValue(next)
        setFieldError(null)
      },
      onScopeChange: setScope,
      onAdd: () => void add(),
      onRetry: () => void add(),
      onNotNow: () => {
        // Mid-save the value may already be stored: never tell the agent "declined" then.
        if (local !== null) {
          return
        }
        setValue('')
        dismissSecretRequest(environmentId, requestId)
        void resolveRequest(environmentId, requestId, 'declined')
      },
      onRestart: () => {
        if (restartAgent && ptyId) {
          useAppStore.getState().queuePaneAccountRestarts([ptyId], restartAgent)
        }
        dismissSecretRequest(environmentId, requestId)
      },
      onDismiss: () => dismissSecretRequest(environmentId, requestId),
      onToggleCollapsed: () => setCollapsed((current) => !current),
      onCollapse: () => setCollapsed(true),
      onDetails: openPanel
        ? () => openPanel({ hostId: environmentId, focus: { secret: event.name } })
        : undefined,
      onFocusChange: setFocused
    }
  }
}
