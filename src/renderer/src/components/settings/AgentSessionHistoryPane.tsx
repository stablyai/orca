import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { SettingsRow, SettingsSegmentedControl, SettingsSwitchRow } from './SettingsFormControls'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  resolveAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../../../shared/ai-vault-search-settings'

// Encoded as strings so the segmented control can carry "all history" as a value.
const HISTORY_VALUES = ['all', '90', '30'] as const
type HistoryValue = (typeof HISTORY_VALUES)[number]

function toHistoryValue(historyDays: number | null): HistoryValue {
  if (historyDays === 90) {
    return '90'
  }
  return historyDays === 30 ? '30' : 'all'
}

function fromHistoryValue(value: HistoryValue): number | null {
  return value === 'all' ? null : Number(value)
}

export function formatAiVaultSearchIndexSize(bytes: number | null): string {
  if (bytes === null) {
    return '—'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`
}

export function AgentSessionHistoryPane({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}): React.JSX.Element {
  const policy = resolveAiVaultSearchSettings(settings)
  const [indexBytes, setIndexBytes] = useState<number | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const mountedRef = useMountedRef()

  const refreshIndexSize = useCallback(async (): Promise<void> => {
    const { bytes } = await window.api.aiVault.searchIndexSize().catch(() => ({ bytes: null }))
    if (mountedRef.current) {
      setIndexBytes(bytes)
    }
  }, [mountedRef])

  useEffect(() => {
    void refreshIndexSize()
  }, [policy.enabled, refreshIndexSize])

  const apply = (next: AiVaultSearchSettings): void => {
    void updateSettings({ aiVaultSearch: next })
  }

  const confirmClear = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.aiVault.clearSearchIndex()
      await refreshIndexSize()
    } finally {
      if (mountedRef.current) {
        setClearing(false)
        setConfirmingClear(false)
      }
    }
  }

  return (
    <div className="space-y-1">
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.AgentSessionHistoryPane.enabledLabel',
          'Search inside conversations'
        )}
        description={translate(
          'auto.components.settings.AgentSessionHistoryPane.enabledDescription',
          'Builds a local index of your agent transcripts on this computer so the Session History panel and `orca search` can match on what was said, not just titles.'
        )}
        checked={policy.enabled}
        onChange={() => apply({ ...policy, enabled: !policy.enabled })}
      />

      <SettingsRow
        label={translate(
          'auto.components.settings.AgentSessionHistoryPane.historyLabel',
          'History to index'
        )}
        description={translate(
          'auto.components.settings.AgentSessionHistoryPane.historyDescription',
          'Older transcripts are skipped when the index is built. Conversations already indexed stay searchable until you clear the index.'
        )}
        control={
          <SettingsSegmentedControl<HistoryValue>
            value={toHistoryValue(policy.historyDays)}
            onChange={(value) => apply({ ...policy, historyDays: fromHistoryValue(value) })}
            ariaLabel={translate(
              'auto.components.settings.AgentSessionHistoryPane.historyLabel',
              'History to index'
            )}
            options={[
              {
                value: 'all',
                label: translate(
                  'auto.components.settings.AgentSessionHistoryPane.historyAll',
                  'All history'
                )
              },
              {
                value: '90',
                label: translate(
                  'auto.components.settings.AgentSessionHistoryPane.history90',
                  'Last 90 days'
                )
              },
              {
                value: '30',
                label: translate(
                  'auto.components.settings.AgentSessionHistoryPane.history30',
                  'Last 30 days'
                )
              }
            ]}
          />
        }
      />

      <SettingsRow
        label={translate(
          'auto.components.settings.AgentSessionHistoryPane.indexSizeLabel',
          'Index size'
        )}
        description={translate(
          'auto.components.settings.AgentSessionHistoryPane.indexSizeDescription',
          'Disk used by the local transcript index on this computer.'
        )}
        control={
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatAiVaultSearchIndexSize(indexBytes)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={indexBytes === null}
              onClick={() => setConfirmingClear(true)}
            >
              {translate(
                'auto.components.settings.AgentSessionHistoryPane.clearIndex',
                'Clear index'
              )}
            </Button>
          </div>
        }
      />

      <Dialog
        open={confirmingClear}
        onOpenChange={(open) => {
          if (!open && !clearing) {
            setConfirmingClear(false)
          }
        }}
      >
        <DialogContent className="max-w-md" showCloseButton={!clearing}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.settings.AgentSessionHistoryPane.clearTitle',
                'Clear the transcript index?'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {policy.enabled
                ? translate(
                    'auto.components.settings.AgentSessionHistoryPane.clearBodyEnabled',
                    'Deletes the index files. Your transcripts are untouched, and Orca starts rebuilding the index right away.'
                  )
                : translate(
                    'auto.components.settings.AgentSessionHistoryPane.clearBodyDisabled',
                    'Deletes the index files. Your transcripts are untouched.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingClear(false)} disabled={clearing}>
              {translate('auto.components.settings.AgentSessionHistoryPane.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmClear()} disabled={clearing}>
              {clearing ? <Loader2 className="animate-spin" /> : null}
              {clearing
                ? translate(
                    'auto.components.settings.AgentSessionHistoryPane.clearing',
                    'Clearing…'
                  )
                : translate(
                    'auto.components.settings.AgentSessionHistoryPane.clearIndex',
                    'Clear index'
                  )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
