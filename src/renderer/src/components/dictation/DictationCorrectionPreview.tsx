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

type DictationCorrectionPreviewProps = {
  rawText: string
  correctedText: string
  onInsertCorrected: () => void
  onInsertRaw: () => void
  onDiscard: () => void
}

export function DictationCorrectionPreview({
  rawText,
  correctedText,
  onInsertCorrected,
  onInsertRaw,
  onDiscard
}: DictationCorrectionPreviewProps): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onDiscard()}>
      <DialogContent showCloseButton className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.dictation.DictationCorrectionPreview.title',
              'Review dictation correction'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.dictation.DictationCorrectionPreview.description',
              'Correction runs locally. Choose the corrected text or keep the original transcript.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-3">
          <TranscriptPreview
            label={translate(
              'auto.components.dictation.DictationCorrectionPreview.corrected',
              'Corrected'
            )}
            text={correctedText}
          />
          <TranscriptPreview
            label={translate(
              'auto.components.dictation.DictationCorrectionPreview.original',
              'Original'
            )}
            text={rawText}
            muted
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onDiscard}>
            {translate('auto.components.dictation.DictationCorrectionPreview.discard', 'Discard')}
          </Button>
          <Button type="button" variant="outline" onClick={onInsertRaw}>
            {translate(
              'auto.components.dictation.DictationCorrectionPreview.useOriginal',
              'Use original'
            )}
          </Button>
          <Button type="button" autoFocus onClick={onInsertCorrected}>
            {translate(
              'auto.components.dictation.DictationCorrectionPreview.insertCorrected',
              'Insert corrected'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TranscriptPreview({
  label,
  text,
  muted = false
}: {
  label: string
  text: string
  muted?: boolean
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={`scrollbar-sleek max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/35 px-3 py-2 text-sm ${muted ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {text}
      </div>
    </div>
  )
}
