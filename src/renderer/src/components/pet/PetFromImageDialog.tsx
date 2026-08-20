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
import { translate } from '@/i18n/i18n'
import type { CustomPet } from '../../../../shared/pet-types'
import { BUNDLED_PETS } from './pet-models'
import { buildPetFromImage, type BuildPetResult } from './pet-from-image'
import { petBuildFailureMessage } from './pet-from-image-message'
import { decodeImageFile, encodeSheetToWebp, sheetToDataUrl } from './pet-image-decode'
import { PetSheetPreview } from './PetSheetPreview'
import { SHEET_ROWS } from './pet-sheet-composer'

type PetFromImageDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (pet: CustomPet) => void
}

type Draft = {
  fileName: string
  build: BuildPetResult
  previewUrl: string | null
}

const PREVIEW_SIZE = 180

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
  const [styleId, setStyleId] = useState<string>(BUNDLED_PETS[0].id)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Why: kept so switching aesthetic re-runs the pipeline without asking the
  // user to pick the same file again.
  const sourceRef = useRef<Awaited<ReturnType<typeof decodeImageFile>> | null>(null)

  const runPipeline = async (styleForRun: string, fileName: string): Promise<void> => {
    const source = sourceRef.current
    if (!source) {
      return
    }
    const build = buildPetFromImage(source, styleForRun)
    const previewUrl = build.ok ? await sheetToDataUrl(build.sheet) : null
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
      sourceRef.current = await decodeImageFile(file)
      await runPipeline(styleId, file.name)
    } catch (cause) {
      setDraft(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const onChooseStyle = async (nextStyle: string): Promise<void> => {
    setStyleId(nextStyle)
    if (!draft) {
      return
    }
    setBusy(true)
    try {
      await runPipeline(nextStyle, draft.fileName)
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
                variant={pet.id === styleId ? 'default' : 'outline'}
                onClick={() => void onChooseStyle(pet.id)}
              >
                {pet.label}
              </Button>
            ))}
          </div>

          <div className="flex min-h-[190px] items-end justify-center rounded-md border border-border bg-accent/5 p-2">
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
