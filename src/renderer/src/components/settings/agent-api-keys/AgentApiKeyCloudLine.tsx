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
  failure,
  onSaveToAccount
}: {
  envName: string
  state: AgentApiKeyCloudRowState
  /** Every host and a variable the proxy swaps. */
  canSave: boolean
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
  return (
    <div className="space-y-1 pl-[22px]">
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
                      'agentApiKeys.cloud.stale',
                      'Your Orca account has an earlier copy · cloud workspaces still use it'
                    )
                  : t('agentApiKeys.cloud.local', 'Only on this computer')}
            </span>
            {canSave && (state === 'local' || state === 'stale') ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0 aria-disabled:pointer-events-none"
                aria-disabled={saving || undefined}
                aria-busy={saving || undefined}
                aria-label={t(
                  'agentApiKeys.cloud.saveLabel',
                  'Save {{name}} to your Orca account',
                  {
                    name: envName
                  }
                )}
                onClick={() => void save()}
              >
                {saving ? <Loader2 className="motion-safe:animate-spin" /> : null}
                {t('agentApiKeys.cloud.save', 'Save to your Orca account')}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {failure && (state === 'local' || state === 'stale') ? (
        <InlineError
          layout="line"
          title={t(
            'agentApiKeys.cloud.saveFailed',
            'Saved on this computer, but not in your Orca account.'
          )}
          detail={
            // The generic transport copy says "Nothing was changed", which isn't true here.
            failure === 'unavailable' || failure === 'timeout' || failure === 'unknown'
              ? t('agentApiKeys.cloud.saveFailedRetry', 'Couldn’t reach Orca Cloud. Try again.')
              : cloudSecretsErrorCopy(failure, t)
          }
        />
      ) : null}
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
      aria-label={t('agentApiKeys.remove.confirmLabel', 'Remove {{name}}', {
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
          {t('auto.components.settings.agentApiKeys.keep', 'Keep')}
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

export type AgentApiKeysNoticeState =
  | { kind: 'kept'; envName: string }
  | { kind: 'imported'; count: number }
  | null

/** One line above the list: the last removal or import, or what failed. */
export function AgentApiKeysNotice({
  failure,
  notice
}: {
  failure: string | null
  notice: AgentApiKeysNoticeState
}): React.JSX.Element | null {
  const t = useTranslate()
  if (failure) {
    return <InlineError density="compact" title={failure} />
  }
  if (notice?.kind === 'kept') {
    return (
      <InlineError
        tone="neutral"
        density="compact"
        title={t(
          'agentApiKeys.remove.kept',
          'Removed from this computer. {{name}} is still in your Orca account.',
          { name: notice.envName }
        )}
        detail={t('agentApiKeys.remove.keptDetail', 'Manage it in Settings › Cloud secrets.')}
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
