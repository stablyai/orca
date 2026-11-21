import type React from 'react'
import { useState } from 'react'
import { Download, Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { SettingsImportReadResult } from '../../../../../../shared/settings/portable-settings'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { getAdvancedSearchEntry } from '../advanced-search'

type SettingsTransferSectionProps = {
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

type ImportFailureReason = Extract<SettingsImportReadResult, { status: 'failed' }>['reason']

function describeImportFailure(reason: ImportFailureReason, t: Translate): string {
  switch (reason) {
    case 'unsupported-version':
      return t(
        'settings.transfer.importFailed.unsupportedVersion',
        'This file comes from a newer Orca. Update Orca, then import it again.'
      )
    case 'too-large':
    case 'invalid-json':
    case 'not-orca-settings':
      return t('settings.transfer.importFailed.notSettings', 'This is not an Orca settings file.')
    case 'unreadable':
      return t('settings.transfer.importFailed.unreadable', 'Orca could not read this file.')
  }
}

export function SettingsTransferSection({
  updateSettings
}: SettingsTransferSectionProps): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const entry = getAdvancedSearchEntry().settingsTransfer

  const run = async (action: 'export' | 'import', work: () => Promise<void>): Promise<void> => {
    setBusy(action)
    try {
      await work()
    } catch (error) {
      console.error(`[settings] settings ${action} failed:`, error)
      toast.error(
        action === 'export'
          ? t('settings.transfer.exportFailed', 'Orca could not save the settings file.')
          : t('settings.transfer.importFailed.unreadable', 'Orca could not read this file.')
      )
    } finally {
      if (mountedRef.current) {
        setBusy(null)
      }
    }
  }

  const handleExport = (): Promise<void> =>
    run('export', async () => {
      const result = await window.api.settings.exportToFile()
      if (result.status === 'saved') {
        toast.success(
          t('settings.transfer.exported', 'Exported {{count}} settings.', {
            count: result.settingCount
          })
        )
      } else if (result.status === 'failed') {
        toast.error(t('settings.transfer.exportFailed', 'Orca could not save the settings file.'))
      }
    })

  const handleImport = (): Promise<void> =>
    run('import', async () => {
      const result = await window.api.settings.readImportFile()
      if (result.status === 'cancelled') {
        return
      }
      if (result.status === 'failed') {
        toast.error(describeImportFailure(result.reason, t))
        return
      }
      const count = Object.keys(result.settings).length
      if (count === 0) {
        toast.message(t('settings.transfer.nothingToImport', 'The file has no settings to import.'))
        return
      }
      updateSettings(result.settings)
      toast.success(t('settings.transfer.imported', 'Imported {{count}} settings.', { count }))
    })

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="flex items-center justify-between gap-4 py-2"
      id="advanced-settings-transfer"
    >
      <div className="min-w-0 shrink space-y-0.5">
        <Label>{t('settings.transfer.title', 'Export and import settings')}</Label>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.transfer.description',
            'Move appearance, editor, terminal and agent preferences to another device. Accounts, tokens and paths stay on this device.'
          )}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void handleExport()}
        >
          {busy === 'export' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          {t('settings.transfer.export', 'Export')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void handleImport()}
        >
          {busy === 'import' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Upload className="size-3.5" />
          )}
          {t('settings.transfer.import', 'Import')}
        </Button>
      </div>
    </SearchableSetting>
  )
}
