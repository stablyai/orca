import type React from 'react'
import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Button } from '../ui/button'
import { SettingsRow, SettingsSegmentedControl, SettingsSwitchRow } from './SettingsFormControls'
import { AppearanceBackgroundSlider } from './AppearanceBackgroundSlider'
import { AppearanceBackgroundImageSelector } from './AppearanceBackgroundImageSelector'
import {
  asBackgroundSettingsUpdate,
  getAppearanceBackgroundAreaOptions,
  getAppearanceBackgroundFitOptions,
  getAppearanceBackgroundSearchEntry,
  resolveAppearanceBackgroundAreas,
  resolveAppearanceBackgroundImage,
  resolveAppearanceBackgroundNumber
} from './appearance-background-section-model'
import type { AppearanceBackgroundArea } from './appearance-background-section-model'
import { useAppearanceBackgroundLibrary } from './use-appearance-background-library'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
export function AppearanceBackgroundSection({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const [imageArea, setImageArea] = useState<AppearanceBackgroundArea>('terminal')
  const [effectsArea, setEffectsArea] = useState<AppearanceBackgroundArea>('terminal')
  const areaOptions = getAppearanceBackgroundAreaOptions()
  const areas = resolveAppearanceBackgroundAreas(settings)
  const byArea = settings.orcaBackgroundByArea ?? {}
  const opacityByArea = settings.orcaBackgroundOpacityByArea ?? {}
  const blurByArea = settings.orcaBackgroundBlurByArea ?? {}
  const selectedImage = resolveAppearanceBackgroundImage(settings, imageArea)
  const opacity = resolveAppearanceBackgroundNumber(
    opacityByArea,
    settings.orcaBackgroundOpacity,
    effectsArea,
    0.35,
    1
  )
  const blur = resolveAppearanceBackgroundNumber(
    blurByArea,
    settings.orcaBackgroundBlur,
    effectsArea,
    0,
    40
  )
  const fit = settings.orcaBackgroundFit ?? 'cover'
  const updateAreaImage = (fileName: string | null): void => {
    updateSettings(
      asBackgroundSettingsUpdate({
        orcaBackgroundByArea: { ...byArea, [imageArea]: fileName },
        orcaBackgroundAreas: { ...areas, [imageArea]: fileName !== null }
      })
    )
  }
  const { library, busy, addImages, openLibrary } = useAppearanceBackgroundLibrary(updateAreaImage)
  return (
    <div className="space-y-3">
      <SettingsRow
        alignTop
        label={getAppearanceBackgroundSearchEntry().title}
        description={getAppearanceBackgroundSearchEntry().description}
        control={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void addImages()}
            >
              {translate(
                'auto.components.settings.AppearanceBackgroundSection.addImage',
                'Add Image'
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!library.dir}
              onClick={() => void openLibrary()}
            >
              {translate(
                'auto.components.settings.AppearanceBackgroundSection.openFolder',
                'Open Backgrounds Folder'
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!selectedImage}
              onClick={() => updateAreaImage(null)}
            >
              {translate(
                'auto.components.settings.AppearanceBackgroundSection.clearArea',
                'Clear Area'
              )}
            </Button>
          </div>
        }
      />

      <SettingsRow
        label={translate(
          'auto.components.settings.AppearanceBackgroundSection.backgroundFor',
          'Background for'
        )}
        description={translate(
          'auto.components.settings.AppearanceBackgroundSection.backgroundForDescription',
          'Choose an area, then select its image. Each area can use a different image.'
        )}
        control={
          <SettingsSegmentedControl
            size="sm"
            ariaLabel={translate(
              'auto.components.settings.AppearanceBackgroundSection.backgroundTarget',
              'Background target'
            )}
            value={imageArea}
            onChange={setImageArea}
            options={areaOptions}
          />
        }
      />

      <div className="flex max-w-full gap-2 overflow-x-auto pb-1" aria-live="polite">
        {library.images.map((image) => (
          <Button
            key={image.fileName}
            type="button"
            variant={selectedImage === image.fileName ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={selectedImage === image.fileName}
            className={cn(
              'max-w-48 shrink-0 truncate font-mono text-[11px]',
              selectedImage === image.fileName
                ? 'ring-1 ring-ring'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => updateAreaImage(image.fileName)}
          >
            {image.fileName}
          </Button>
        ))}
      </div>
      {library.images.length === 0 ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.AppearanceBackgroundSection.empty',
            'No images yet. Add an image from your computer.'
          )}
        </p>
      ) : null}
      <AppearanceBackgroundImageSelector
        images={library.images}
        selectedImage={selectedImage}
        onSelect={updateAreaImage}
      />

      <div className="divide-y divide-border/40">
        {areaOptions.map((area) => (
          <SettingsSwitchRow
            key={area.value}
            label={area.label}
            description={area.description}
            checked={areas[area.value]}
            onChange={() =>
              updateSettings(
                asBackgroundSettingsUpdate({
                  orcaBackgroundAreas: { ...areas, [area.value]: !areas[area.value] }
                })
              )
            }
          />
        ))}
      </div>

      <SettingsRow
        label={translate(
          'auto.components.settings.AppearanceBackgroundSection.effectsFor',
          'Effects for'
        )}
        description={translate(
          'auto.components.settings.AppearanceBackgroundSection.effectsDescription',
          'Adjust opacity and blur for the selected area.'
        )}
        control={
          <div className="flex items-center gap-2">
            <SettingsSegmentedControl
              size="sm"
              ariaLabel={translate(
                'auto.components.settings.AppearanceBackgroundSection.effectsTarget',
                'Background effects target'
              )}
              value={effectsArea}
              onChange={setEffectsArea}
              options={areaOptions}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={opacity === 1 && blur === 0}
              aria-label={translate(
                'auto.components.settings.AppearanceBackgroundSection.resetEffects',
                'Reset background effects'
              )}
              onClick={() =>
                updateSettings(
                  asBackgroundSettingsUpdate({
                    orcaBackgroundOpacityByArea: { ...opacityByArea, [effectsArea]: 1 },
                    orcaBackgroundBlurByArea: { ...blurByArea, [effectsArea]: 0 }
                  })
                )
              }
            >
              {translate('auto.components.settings.AppearanceBackgroundSection.reset', 'Reset')}
            </Button>
          </div>
        }
      />

      <AppearanceBackgroundSlider
        label={translate('auto.components.settings.AppearanceBackgroundSection.opacity', 'Opacity')}
        description={translate(
          'auto.components.settings.AppearanceBackgroundSection.opacityDescription',
          'How strongly the image shows through. Lower keeps text readable.'
        )}
        value={opacity}
        min={0}
        max={1}
        step={0.01}
        onChange={(next) =>
          updateSettings(
            asBackgroundSettingsUpdate({
              orcaBackgroundOpacityByArea: { ...opacityByArea, [effectsArea]: next }
            })
          )
        }
      />
      <AppearanceBackgroundSlider
        label={translate('auto.components.settings.AppearanceBackgroundSection.blur', 'Blur')}
        description={translate(
          'auto.components.settings.AppearanceBackgroundSection.blurDescription',
          'Softens the image so it does not compete with text.'
        )}
        value={blur}
        min={0}
        max={40}
        step={1}
        suffix="px"
        onChange={(next) =>
          updateSettings(
            asBackgroundSettingsUpdate({
              orcaBackgroundBlurByArea: { ...blurByArea, [effectsArea]: next }
            })
          )
        }
      />

      <SettingsRow
        label={translate('auto.components.settings.AppearanceBackgroundSection.fit', 'Fit')}
        description={translate(
          'auto.components.settings.AppearanceBackgroundSection.fitDescription',
          'How the image is scaled. Applied to every background area.'
        )}
        control={
          <SettingsSegmentedControl
            size="sm"
            ariaLabel={translate('auto.components.settings.AppearanceBackgroundSection.fit', 'Fit')}
            value={fit}
            onChange={(orcaBackgroundFit) =>
              updateSettings(asBackgroundSettingsUpdate({ orcaBackgroundFit }))
            }
            options={getAppearanceBackgroundFitOptions()}
          />
        }
      />
    </div>
  )
}
