import { useState } from 'react'
import { toast } from 'sonner'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import {
  hasSavedPiSourceControlModel,
  resetPiSourceControlModelsForHost
} from '../../../../shared/pi-source-control-model-reset'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

export function PiConfiguredModelReset({
  config,
  hostKey,
  writeConfig
}: {
  config: SourceControlAiSettings
  hostKey: string
  writeConfig: (patch: SourceControlAiSettingsPatch) => Promise<void>
}): React.JSX.Element | null {
  const [saving, setSaving] = useState(false)
  if (!hasSavedPiSourceControlModel(config, hostKey)) {
    return null
  }
  const reset = async (): Promise<void> => {
    setSaving(true)
    try {
      await writeConfig((current) => resetPiSourceControlModelsForHost(current, hostKey))
      toast.success(
        translate(
          'settings.piConfiguredModelReset.success',
          'Pi now uses its configured model on this host.'
        )
      )
    } catch {
      toast.error(
        translate(
          'settings.piConfiguredModelReset.error',
          'Could not reset saved Pi model choices.'
        )
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-1">
        <Label>
          {translate('settings.piConfiguredModelReset.title', 'Saved Pi model choices')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.piConfiguredModelReset.description',
            'Reset saved Pi model choices for commit messages, pull requests, and branch names on this host. Models in recipe CLI arguments still apply.'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate('settings.piConfiguredModelReset.host', 'Host: {{host}}', {
            host: hostKey === 'local' ? 'This computer' : 'Current workspace host'
          })}
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={saving} onClick={() => void reset()}>
        {translate('settings.piConfiguredModelReset.action', 'Use Pi’s configured model')}
      </Button>
    </div>
  )
}
