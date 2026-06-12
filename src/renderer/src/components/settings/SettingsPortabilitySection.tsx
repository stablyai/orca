import { useState } from 'react'
import { Download, Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { SettingsImportPreview } from '../../../../shared/settings-portability'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsImportModal } from './SettingsImportModal'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { getAdvancedSearchEntry } from './advanced-search'
import { translate } from '@/i18n/i18n'

type SettingsPortabilitySectionProps = {
  fetchSettings?: () => Promise<void>
}

export function SettingsPortabilitySection({
  fetchSettings
}: SettingsPortabilitySectionProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const [exportingSettings, setExportingSettings] = useState(false)
  const [pickingImportFile, setPickingImportFile] = useState(false)
  const [importPreview, setImportPreview] = useState<SettingsImportPreview | null>(null)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [applyingImport, setApplyingImport] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const handleExportSettings = async (): Promise<void> => {
    setExportingSettings(true)
    try {
      const result = await window.api.settings.exportPortable()
      if (!result.success) {
        if (!result.cancelled && result.error) {
          toast.error(result.error)
        }
        return
      }
      toast.success(
        translate(
          'auto.components.settings.SettingsPortabilitySection.8ea7a22e4a',
          'Settings exported.'
        ),
        { description: result.filePath }
      )
    } finally {
      if (mountedRef.current) {
        setExportingSettings(false)
      }
    }
  }

  const handlePickImportFile = async (): Promise<void> => {
    setPickingImportFile(true)
    try {
      const preview = await window.api.settings.previewPortableImport()
      if (!mountedRef.current || preview.cancelled) {
        return
      }
      if (!preview.ok) {
        toast.error(
          preview.error ??
            translate(
              'auto.components.settings.SettingsPortabilitySection.be8ec0228d',
              'Failed to read settings file.'
            )
        )
        return
      }
      setImportPreview(preview)
      setImportError(null)
      setImportModalOpen(true)
    } finally {
      if (mountedRef.current) {
        setPickingImportFile(false)
      }
    }
  }

  const handleApplyImport = async (): Promise<void> => {
    if (importPreview?.filePath === undefined) {
      return
    }
    setApplyingImport(true)
    try {
      const result = await window.api.settings.importPortable(importPreview.filePath)
      if (!result.success) {
        if (mountedRef.current) {
          setImportError(
            result.error ??
              translate(
                'auto.components.settings.SettingsPortabilitySection.f95c1e1ae7',
                'Failed to import settings.'
              )
          )
        }
        return
      }
      if (fetchSettings) {
        try {
          await fetchSettings()
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.settings.SettingsPortabilitySection.e6a24b08ec',
                  'Settings imported, but refresh failed.'
                )
          )
        }
      }
      if (mountedRef.current) {
        setImportModalOpen(false)
      }
      toast.success(
        translate(
          'auto.components.settings.SettingsPortabilitySection.23ddedc680',
          'Settings imported.'
        )
      )
    } finally {
      if (mountedRef.current) {
        setApplyingImport(false)
      }
    }
  }

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.SettingsPortabilitySection.3c528a3c77',
          'Settings Portability'
        )}
        description={translate(
          'auto.components.settings.SettingsPortabilitySection.30c14c6a9f',
          'Move portable preferences and keyboard shortcuts between Orca installs.'
        )}
      />

      <SearchableSetting
        title={getAdvancedSearchEntry().settingsPortability.title}
        description={getAdvancedSearchEntry().settingsPortability.description}
        keywords={getAdvancedSearchEntry().settingsPortability.keywords}
        className="space-y-2 py-2"
        id="advanced-settings-portability"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 shrink space-y-1">
            <Label>
              {translate(
                'auto.components.settings.SettingsPortabilitySection.3635a8a67b',
                'Import & Export'
              )}
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.settings.SettingsPortabilitySection.d1168dcfa5',
                'Skips accounts, tokens, workspace paths, and other machine-specific values.'
              )}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handlePickImportFile()}
              disabled={pickingImportFile || exportingSettings}
              className="gap-1.5"
            >
              {pickingImportFile ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {translate(
                'auto.components.settings.SettingsPortabilitySection.39ffc19d3c',
                'Import'
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleExportSettings()}
              disabled={exportingSettings || pickingImportFile}
              className="gap-1.5"
            >
              {exportingSettings ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {translate(
                'auto.components.settings.SettingsPortabilitySection.fdb8c7d1da',
                'Export'
              )}
            </Button>
          </div>
        </div>
      </SearchableSetting>

      <SettingsImportModal
        open={importModalOpen}
        onOpenChange={(open) => {
          setImportModalOpen(open)
          if (!open) {
            setImportError(null)
          }
        }}
        preview={importPreview}
        applying={applyingImport}
        applyError={importError}
        onApply={() => void handleApplyImport()}
      />
    </section>
  )
}
