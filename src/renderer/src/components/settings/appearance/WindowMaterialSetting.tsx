import { useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  hostWindowMaterial,
  resolveWindowMaterial,
  selectableWindowMaterials,
  windowMaterialPreference,
  type WindowMaterial,
  type WindowMaterialHost
} from '../../../../../shared/window-material'
import { Button } from '../../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { useMountedRef } from '@/hooks/useMountedRef'
import { readPrefersReducedTransparency } from '@/hooks/use-reduce-visual-effects'
import {
  activeWindowMaterial,
  rendererWindowMaterialHost
} from '@/app-shell/appearance/window-material-runtime'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type WindowMaterialSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function windowMaterialLabel(
  material: WindowMaterial,
  host: WindowMaterialHost,
  t: Translate = translate
): string {
  if (material === 'off') {
    return t('settings.windowMaterial.off', 'Opaque')
  }
  if (material === 'translucent') {
    return t('settings.windowMaterial.translucent', 'Translucent')
  }
  return host.platform === 'win32'
    ? t('settings.windowMaterial.acrylic', 'Acrylic blur')
    : t('settings.windowMaterial.blur', 'Blurred')
}

function windowMaterialHint(
  settings: GlobalSettings,
  host: WindowMaterialHost,
  t: Translate = translate
): string {
  const description = t(
    'settings.windowMaterial.description',
    'What shows behind translucent terminals. Requires restart.'
  )
  if (selectableWindowMaterials(host).length === 1) {
    return t(
      'settings.windowMaterial.windowsUnsupported',
      'Requires Windows 11 version 22H2 or later.'
    )
  }
  if (windowMaterialPreference(settings, host.platform) === 'off') {
    return description
  }
  if (settings.reduceVisualEffects === true || readPrefersReducedTransparency()) {
    return t(
      'settings.windowMaterial.reducedEffects',
      'Off while Reduce Visual Effects or the system Reduce Transparency setting is on.'
    )
  }
  if ((settings.terminalBackgroundOpacity ?? 1) >= 1) {
    return t(
      'settings.windowMaterial.needsOpacity',
      'Lower Background Opacity below 1 to see the desktop through terminals.'
    )
  }
  return host.platform === 'linux'
    ? t(
        'settings.windowMaterial.linuxCompositor',
        'Your compositor decides whether to blur it. Requires restart.'
      )
    : description
}

function RestartBanner(): React.JSX.Element {
  const t = useTranslate()
  const [relaunching, setRelaunching] = useState(false)
  const mountedRef = useMountedRef()

  const relaunch = async (): Promise<void> => {
    if (relaunching) {
      return
    }
    setRelaunching(true)
    try {
      await window.api.app.relaunch()
    } catch {
      if (mountedRef.current) {
        setRelaunching(false)
      }
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
          {t('auto.components.settings.TerminalWindowSection.c65bb9ce63', 'Restart required')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.windowMaterial.restartDescription',
            'Restart Orca to apply the window material change.'
          )}
        </p>
      </div>
      <Button
        size="sm"
        variant="default"
        className="shrink-0 gap-1.5"
        disabled={relaunching}
        onClick={() => void relaunch()}
      >
        <RotateCw className={`size-3 ${relaunching ? 'animate-spin' : ''}`} />
        {relaunching
          ? t('auto.components.settings.TerminalWindowSection.907131d741', 'Restarting…')
          : t('auto.components.settings.TerminalWindowSection.8abdab9f7c', 'Restart now')}
      </Button>
    </div>
  )
}

/** Desktop main window only; the web client cannot create or restart the host's window. */
export function WindowMaterialSetting({
  settings,
  updateSettings
}: WindowMaterialSettingProps): React.JSX.Element {
  const t = useTranslate()
  const host = rendererWindowMaterialHost()
  const selectable = selectableWindowMaterials(host)
  const label = t('settings.windowMaterial.fc2ba9b528', 'Window material')
  // Why compare resolved values: opacity and Reduce Visual Effects also decide the material.
  const restartPending =
    resolveWindowMaterial(settings, host, readPrefersReducedTransparency()) !==
    activeWindowMaterial()

  return (
    <>
      <SettingsRow
        label={label}
        description={windowMaterialHint(settings, host, t)}
        control={
          <Select
            value={hostWindowMaterial(windowMaterialPreference(settings, host.platform), host)}
            disabled={selectable.length === 1}
            onValueChange={(value) => {
              const material = selectable.find((option) => option === value)
              if (material) {
                updateSettings({ windowMaterial: material })
              }
            }}
          >
            <SelectTrigger size="sm" className="min-w-[160px]" aria-label={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {selectable.map((material) => (
                <SelectItem key={material} value={material}>
                  {windowMaterialLabel(material, host, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {restartPending ? <RestartBanner /> : null}
    </>
  )
}
