import { useState } from 'react'
import { Cloud, HardDrive, Loader2 } from 'lucide-react'
import type { AgentApiKeyCloudRowState } from '../../../../../shared/agent-api-keys/agent-api-key-cloud'
import type { CloudSecretsErrorCode } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { InlineError } from '../../ui/inline-error'
import { cloudSecretsErrorCopy } from '../cloud-secrets/cloud-secrets-copy'

/** Where a key lives, under its row: the Orca account (with this computer as a cache) or here only. */
export function AgentApiKeyCloudLine({
  envName,
  state,
  canSave,
  offline = false,
  failure,
  onSaveToAccount
}: {
  envName: string
  state: AgentApiKeyCloudRowState
  /** Every host and a variable the proxy swaps. */
  canSave: boolean
  /** Orca can't be reached: show the last-known state, without actions that would fail. */
  offline?: boolean
  failure: CloudSecretsErrorCode | undefined
  onSaveToAccount: () => Promise<CloudSecretsErrorCode | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  if (state === 'none') {
    return null
  }
  const save = async (): Promise<void> => {
    if (saving) {
      return
    }
    setSaving(true)
    await onSaveToAccount()
    setSaving(false)
  }
  // A failed account write replaces the status line: one line says what happened and offers retry.
  if (failure && canSave && !offline && (state === 'local' || state === 'stale')) {
    const transport = failure === 'unavailable' || failure === 'timeout' || failure === 'unknown'
    return (
      <div className="pl-[22px]">
        <InlineError
          density="compact"
          title={
            state === 'stale'
              ? t(
                  'agentApiKeys.cloud.updateFailed',
                  'Saved on this computer. Couldn’t update your Orca account, so cloud workspaces still use the older copy.'
                )
              : t(
                  'agentApiKeys.cloud.saveFailedLocal',
                  'Saved on this computer. Couldn’t save it to your Orca account.'
                )
          }
          // Transport copy says "Nothing was changed", which isn't true after a local save.
          detail={transport ? undefined : cloudSecretsErrorCopy(failure, t)}
          retryLabel={t('agentApiKeys.cloud.retry', 'Try again')}
          retrying={saving}
          onRetry={() => void save()}
        />
      </div>
    )
  }
  return (
    <div className="pl-[22px]">
      <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
        {state === 'synced' ? (
          <>
            <Cloud aria-hidden className="size-3.5 shrink-0" />
            <span>
              {t(
                'agentApiKeys.cloud.synced',
                'Saved in your Orca account · cached on this computer'
              )}
            </span>
          </>
        ) : (
          <>
            <HardDrive aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {state === 'not-swappable'
                ? t(
                    'agentApiKeys.cloud.notSwappable',
                    'Only on this computer · not used in Orca Cloud'
                  )
                : state === 'stale'
                  ? t(
                      'agentApiKeys.cloud.staleCopy',
                      'Your Orca account has an older copy. Cloud workspaces still use it.'
                    )
                  : t('agentApiKeys.cloud.local', 'Only on this computer')}
            </span>
            {canSave && !offline && (state === 'local' || state === 'stale') ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0 aria-disabled:pointer-events-none"
                aria-disabled={saving || undefined}
                aria-busy={saving || undefined}
                aria-label={
                  state === 'stale'
                    ? t('agentApiKeys.cloud.updateLabel', 'Update {{name}} in your Orca account', {
                        name: envName
                      })
                    : t('agentApiKeys.cloud.saveLabel', 'Save {{name}} to your Orca account', {
                        name: envName
                      })
                }
                onClick={() => void save()}
              >
                {saving ? <Loader2 className="motion-safe:animate-spin" /> : null}
                {state === 'stale'
                  ? t('agentApiKeys.cloud.update', 'Update your Orca account')
                  : t('agentApiKeys.cloud.save', 'Save to your Orca account')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

/** Removing a key this computer saved to the Orca account asks what happens to that copy. */
export function AgentApiKeyRemoveFromAccountConfirm({
  envName,
  onCancel,
  onRemove
}: {
  envName: string
  onCancel: () => void
  onRemove: (fromAccount: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="group"
      aria-label={t('agentApiKeys.remove.confirmLabel', 'Remove', {
        name: envName
      })}
      className="ml-[22px] space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
    >
      <p className="text-foreground">
        {t(
          'agentApiKeys.remove.fromAccountQuestion',
          'Also remove it from your Orca account? Cloud workspaces will stop using it.'
        )}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          {t('agentApiKeys.remove.cancel', 'Cancel')}
        </Button>
        <Button variant="outline" size="xs" onClick={() => onRemove(false)}>
          {t('agentApiKeys.remove.thisComputerOnly', 'Remove from this computer only')}
        </Button>
        <Button variant="destructive-chip" size="xs" onClick={() => onRemove(true)}>
          {t('agentApiKeys.remove.both', 'Remove from both')}
        </Button>
      </div>
    </div>
  )
}

export type AgentApiKeysNoticeState = { kind: 'kept' } | { kind: 'imported'; count: number } | null

/** One line above the list: the last removal or import, or what failed. */
export function AgentApiKeysNotice({
  failure,
  notice,
  unreachable = false
}: {
  failure: string | null
  notice: AgentApiKeysNoticeState
  /** Signed in, but Orca can't be reached: the rows show the last-known state. */
  unreachable?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const offline = unreachable ? (
    <InlineError
      tone="neutral"
      density="compact"
      title={t('agentApiKeys.cloud.unreachable', 'Can’t reach your Orca account right now')}
      detail={t(
        'agentApiKeys.cloud.unreachableDetail',
        'Showing the last known state. Keys you save now go to your Orca account when Orca is back.'
      )}
    />
  ) : null
  const message = noticeMessage(failure, notice, t)
  return offline || message ? (
    <div className="space-y-2">
      {offline}
      {message}
    </div>
  ) : null
}

function noticeMessage(
  failure: string | null,
  notice: AgentApiKeysNoticeState,
  t: ReturnType<typeof useTranslate>
): React.JSX.Element | null {
  if (failure) {
    return <InlineError density="compact" title={failure} />
  }
  if (notice?.kind === 'kept') {
    return (
      <InlineError
        tone="neutral"
        density="compact"
        title={t(
          'agentApiKeys.remove.stillInAccount',
          'Still in your Orca account. Manage it in Settings → Orca Cloud → Cloud secrets.'
        )}
      />
    )
  }
  if (notice?.kind === 'imported') {
    return (
      <InlineError
        tone="neutral"
        density="compact"
        title={
          notice.count === 1
            ? t('agentApiKeys.import.doneOne', 'Imported 1 key.')
            : t('agentApiKeys.import.done', 'Imported {{count}} keys.', { count: notice.count })
        }
      />
    )
  }
  return null
}
