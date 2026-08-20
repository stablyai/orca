import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { translate } from '@/i18n/i18n'
import type { CustomPet } from '../../../../shared/pet-types'
import { BUNDLED_PETS } from './pet-models'
import { buildPetFromImage, type BuildPetResult, type PetBuildMode } from './pet-from-image'
import { petBuildFailureMessage } from './pet-from-image-message'
import { decodeImageFile, encodeSheetToWebp, imageToDataUrl } from './pet-image-decode'
import { BACKGROUND_TOLERANCE, type RgbaImage } from './pet-image-cutout'
import type { CropRect } from './pet-image-crop'
import { petRigFor } from './pet-rigs'
import { PetSheetPreview } from './PetSheetPreview'
import { PetSourceCrop } from './PetSourceCrop'
import { SHEET_ROWS } from './pet-sheet-composer'

type PetFromImageDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (pet: CustomPet) => void
}

/** Everything the user can turn that changes the pet. */
type BuildSettings = {
  styleId: string
  mode: PetBuildMode
  crop: CropRect | null
  tolerance: number
}

type Draft = {
  fileName: string
  build: BuildPetResult
  previewUrl: string | null
}

const PREVIEW_SIZE = 180
const CROP_BOX = 120

// Why: getters, matching pet-models — a module-level `translate()` call would
// run before i18n is ready and would not follow a language change afterwards.
const MODES: { id: PetBuildMode; label: string; hint: string }[] = [
  {
    id: 'whole-body',
    get label() {
      return translate('auto.components.pet.fromImage.modeWholeBody', 'Whole body')
    },
    get hint() {
      return translate(
        'auto.components.pet.fromImage.modeWholeBodyHint',
        'Works with any picture. It glides rather than walks.'
      )
    }
  },
  {
    id: 'rigged',
    get label() {
      return translate('auto.components.pet.fromImage.modeRigged', 'Walking legs')
    },
    get hint() {
      return translate(
        'auto.components.pet.fromImage.modeRiggedHint',
        'Finds legs in the picture so it can walk. Falls back if it cannot.'
      )
    }
  },
  {
    id: 'head-swap',
    get label() {
      return translate('auto.components.pet.fromImage.modeHeadSwap', 'Head only')
    },
    get hint() {
      return translate(
        'auto.components.pet.fromImage.modeHeadSwapHint',
        'Your picture as the head on the pet body. Animates fully.'
      )
    }
  }
]

/** Turns an uploaded image into a pet, in one of the bundled aesthetics.
 *
 *  Nothing is written until the user confirms: the pipeline is deterministic, so
 *  the preview they approve is byte-for-byte what gets saved. A rejected cutout
 *  never reaches a save button — a broken pet is worse than no pet. */
export function PetFromImageDialog({
  open,
  onOpenChange,
  onCreated
}: PetFromImageDialogProps): React.JSX.Element {
  const [settings, setSettings] = useState<BuildSettings>({
    styleId: BUNDLED_PETS[0].id,
    mode: 'whole-body',
    crop: null,
    tolerance: BACKGROUND_TOLERANCE.default
  })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Why: kept so changing a setting re-runs the pipeline without asking the
  // user to pick the same file again.
  const sourceRef = useRef<RgbaImage | null>(null)

  const runPipeline = async (next: BuildSettings, fileName: string): Promise<void> => {
    const source = sourceRef.current
    if (!source) {
      return
    }
    // Why: head-swap composes onto the pet's own artwork, so it has to be
    // decoded first. The other modes never touch it, so it is not loaded.
    let petBody: RgbaImage | null = null
    if (next.mode === 'head-swap') {
      const pet = BUNDLED_PETS.find((p) => p.id === next.styleId)
      const rig = petRigFor(next.styleId)
      if (pet && rig) {
        petBody = await decodeImageFile(await (await fetch(pet.url)).blob())
      }
    }
    const build = buildPetFromImage(source, next.styleId, {
      mode: next.mode,
      petBody,
      crop: next.crop ?? undefined,
      backgroundTolerance: next.tolerance
    })
    const previewUrl = build.ok ? await imageToDataUrl(build.sheet) : null
    setDraft({ fileName, build, previewUrl })
  }

  const onPick = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const source = await decodeImageFile(file)
      sourceRef.current = source
      // Why: framing and tolerance describe one picture. Carrying them onto the
      // next upload would silently build it from a box drawn around something
      // that is no longer there.
      const fresh: BuildSettings = {
        ...settings,
        crop: null,
        tolerance: BACKGROUND_TOLERANCE.default
      }
      setSettings(fresh)
      setSourceUrl(await imageToDataUrl(source))
      await runPipeline(fresh, file.name)
    } catch (cause) {
      setDraft(null)
      setSourceUrl(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const rebuild = async (patch: Partial<BuildSettings>): Promise<void> => {
    const next = { ...settings, ...patch }
    setSettings(next)
    if (!draft) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await runPipeline(next, draft.fileName)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const onConfirm = async (): Promise<void> => {
    if (!draft?.build.ok) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const sheet = await encodeSheetToWebp(draft.build.sheet)
      const pet = await window.api.pet.createGenerated({
        sheet,
        manifest: draft.build.manifest,
        label: draft.fileName.replace(/\.[^.]+$/, '')
      })
      onCreated(pet)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const rejection = draft && !draft.build.ok ? petBuildFailureMessage(draft.build.reason) : null
  const ready = draft?.build.ok === true
  // Why: surfaced, never silent. Asking for a walk and quietly getting a glide
  // leaves the user thinking the feature is broken.
  const degraded =
    draft?.build.ok === true && draft.build.mode !== draft.build.requestedMode
      ? translate(
          'auto.components.pet.fromImage.rigFellBack',
          'No legs could be found in this picture, so it uses whole body instead.'
        )
      : null
  const crop = settings.crop

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.pet.fromImage.title', 'Create a pet from an image')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.pet.fromImage.description',
              'Pick a picture and a style. A PNG with a transparent background works best.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <input
            type="file"
            accept="image/png,image/webp,image/jpeg,image/gif"
            onChange={onPick}
            aria-label={translate('auto.components.pet.fromImage.pick', 'Choose an image')}
          />

          <div className="flex items-center gap-2">
            {BUNDLED_PETS.map((pet) => (
              <Button
                key={pet.id}
                type="button"
                size="sm"
                variant={pet.id === settings.styleId ? 'default' : 'outline'}
                onClick={() => void rebuild({ styleId: pet.id })}
              >
                {pet.label}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {MODES.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={option.id === settings.mode ? 'secondary' : 'ghost'}
                title={option.hint}
                onClick={() => void rebuild({ mode: option.id })}
              >
                {option.label}
              </Button>
            ))}
          </div>

          {sourceRef.current && sourceUrl ? (
            <div className="flex items-start gap-3">
              <PetSourceCrop
                sourceUrl={sourceUrl}
                image={sourceRef.current}
                crop={crop}
                onCrop={(rect) => void rebuild({ crop: rect })}
                box={CROP_BOX}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.pet.fromImage.cropHint',
                    'Drag a box around the character if the picture has more in it.'
                  )}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!crop}
                  onClick={() => void rebuild({ crop: null })}
                >
                  {translate('auto.components.pet.fromImage.cropReset', 'Use the whole picture')}
                </Button>
                <div data-tolerance={settings.tolerance} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    {translate(
                      'auto.components.pet.fromImage.tolerance',
                      'How much of the background to remove'
                    )}
                  </span>
                  <Slider
                    value={[settings.tolerance]}
                    min={BACKGROUND_TOLERANCE.min}
                    max={BACKGROUND_TOLERANCE.max}
                    step={4}
                    onValueChange={([value]) => void rebuild({ tolerance: value })}
                    thumbLabels={[
                      translate(
                        'auto.components.pet.fromImage.tolerance',
                        'How much of the background to remove'
                      )
                    ]}
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div
            className="flex min-h-[190px] items-end justify-center rounded-md border border-border bg-accent/5 p-2"
            data-build-mode={draft?.build.ok === true ? draft.build.mode : 'none'}
            data-requested-mode={settings.mode}
            data-crop={crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : 'none'}
          >
            {busy ? (
              <Loader2 className="mb-16 size-5 animate-spin text-muted-foreground" aria-hidden />
            ) : rejection ? (
              <p className="mb-16 text-center text-xs text-destructive">{rejection}</p>
            ) : ready && draft?.previewUrl && draft.build.ok ? (
              <PetSheetPreview
                sheetUrl={draft.previewUrl}
                frame={draft.build.manifest.frame}
                rows={SHEET_ROWS}
                size={PREVIEW_SIZE}
              />
            ) : (
              <p className="mb-16 text-xs text-muted-foreground">
                {translate('auto.components.pet.fromImage.empty', 'No image chosen yet.')}
              </p>
            )}
          </div>

          {degraded ? <p className="text-xs text-muted-foreground">{degraded}</p> : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {translate('auto.components.pet.fromImage.cancel', 'Cancel')}
          </Button>
          <Button type="button" disabled={!ready || busy} onClick={() => void onConfirm()}>
            {translate('auto.components.pet.fromImage.confirm', 'Create pet')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
