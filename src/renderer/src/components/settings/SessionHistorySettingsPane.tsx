import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  AiVaultSearchSettingsSchema,
  resolveAiVaultSearchSettings
} from '../../../../shared/ai-vault-search-settings'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { isWebClientLocation } from '@/lib/web-client-location'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'
import { SessionHistoryIndexStatus } from './SessionHistoryIndexStatus'

export function SessionHistorySettingsPane({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}): React.JSX.Element {
  const policy = resolveAiVaultSearchSettings(settings)
  const isWebClient = isWebClientLocation()
  const confirm = useConfirmationDialog()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function save(updates: Partial<typeof policy>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await updateSettings({
        aiVaultSearch: AiVaultSearchSettingsSchema.parse({ ...policy, ...updates })
      })
    } catch {
      if (mounted.current) {
        setError(
          translate(
            'sessionHistory.settings.saveError',
            'Could not save session search settings. Try again.'
          )
        )
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  async function toggleEnabled(): Promise<void> {
    if (policy.enabled) {
      await save({ enabled: false })
      return
    }
    setBusy(true)
    let accepted = false
    try {
      accepted = await confirm({
        title: translate('sessionHistory.settings.enableTitle', 'Start indexing agent sessions?'),
        description: translate(
          'sessionHistory.settings.enableConsent',
          'Orca will build a local search index on this computer. It copies conversation text and tool output from agent transcripts as written; content is not redacted. Indexing starts now, runs in the background, and the first scan can take several minutes. You can turn it off at any time; progress is kept.'
        ),
        confirmLabel: translate('sessionHistory.settings.enableConfirm', 'Start indexing')
      })
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
    if (!accepted || !mounted.current) {
      return
    }
    await save({ enabled: true })
  }

  async function deleteIndex(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const accepted = await confirm({
        title: translate(
          'sessionHistory.settings.deleteTitle',
          'Delete this computer’s search index?'
        ),
        description: policy.enabled
          ? translate(
              'sessionHistory.settings.deleteEnabled',
              'Remove the search index from this computer. Original transcripts are not touched. Search is on, so Orca scans them again from scratch afterward.'
            )
          : translate(
              'sessionHistory.settings.deleteDisabled',
              'Remove the search index from this computer. Original transcripts are not touched. Search stays off.'
            ),
        confirmLabel: translate('sessionHistory.settings.delete', 'Delete index'),
        confirmVariant: 'destructive'
      })
      if (!accepted || !mounted.current) {
        return
      }
      await window.api.aiVault.clearSearchIndex()
      if (mounted.current) {
        setRefresh((value) => value + 1)
        toast.success(
          translate(
            'sessionHistory.settings.cleared',
            'Search index cleared. Original transcripts were kept.'
          )
        )
      }
    } catch {
      if (mounted.current) {
        setError(
          translate('sessionHistory.settings.clearError', 'Could not clear the index. Try again.')
        )
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div className="divide-y divide-border">
      <SettingsSwitchRow
        label={translate('sessionHistory.settings.enable', 'Enable session history search')}
        description={
          isWebClient
            ? translate(
                'sessionHistory.settings.webUnsupported',
                'Manage indexing in the Orca desktop app on the computer that owns the transcripts. These controls are unavailable from a paired client.'
              )
            : translate(
                'sessionHistory.settings.consent',
                'Create a local index copy of agent transcripts on this computer, including conversation text and tool output as written. Content is not redacted. Turning search off stops indexing and keeps the index copy.'
              )
        }
        checked={policy.enabled}
        disabled={busy || isWebClient}
        onChange={() => void toggleEnabled()}
      />
      {!isWebClient ? (
        <SessionHistoryIndexStatus enabled={policy.enabled} refresh={refresh} />
      ) : null}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="xs" className="-ml-2">
            {translate('sessionHistory.settings.advanced', 'Advanced')}
            <ChevronDown
              className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SettingsRow
            label={translate('sessionHistory.settings.deleteIndexCopy', 'Delete index copy')}
            description={
              policy.enabled
                ? translate(
                    'sessionHistory.settings.deleteEnabled',
                    'Remove the search index from this computer. Original transcripts are not touched. Search is on, so Orca scans them again from scratch afterward.'
                  )
                : translate(
                    'sessionHistory.settings.deleteDisabled',
                    'Remove the search index from this computer. Original transcripts are not touched. Search stays off.'
                  )
            }
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={busy || isWebClient}
                onClick={() => void deleteIndex()}
              >
                {translate('sessionHistory.settings.delete', 'Delete index')}
              </Button>
            }
          />
        </CollapsibleContent>
      </Collapsible>
      {error ? (
        <p role="alert" className="pt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
