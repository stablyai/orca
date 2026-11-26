import { useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { perforceChangelistLabel } from './perforce-changelist-label'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { PerforceChangelist } from '../../../../../shared/perforce/perforce-types'
import { translate } from '@/i18n/i18n'

/** Asks for a changelist description; nothing is created until it is confirmed and accepted. */
export function NewChangelistDialog({
  fileCount,
  initialDescription = '',
  onGenerate,
  onCancel,
  onCreate
}: {
  fileCount: number
  initialDescription?: string
  /** Drafts a description from the selected files; omitted when AI descriptions are off. */
  onGenerate?: () => Promise<string | null>
  onCancel: () => void
  onCreate: (description: string) => Promise<boolean>
}) {
  const [description, setDescription] = useState(initialDescription)
  const [pending, setPending] = useState(false)
  const [generating, setGenerating] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const generate = async (): Promise<void> => {
    if (!onGenerate) {
      return
    }
    setGenerating(true)
    const drafted = await onGenerate()
    setGenerating(false)
    if (drafted) {
      setDescription(drafted)
      textareaRef.current?.focus()
    }
  }
  const submit = async (): Promise<void> => {
    setPending(true)
    const ok = await onCreate(description.trim())
    setPending(false)
    if (ok) {
      onCancel()
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="sm:max-w-md"
        // Why: Radix focuses the dialog itself on open, so autoFocus on the field is ignored.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          textareaRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('perforce.ui.moveToNewChangelist', 'Move to new changelist')}
          </DialogTitle>
          <DialogDescription>
            {fileCount === 0
              ? translate(
                  'perforce.ui.newChangelistEmptyDescription',
                  'An empty changelist will be created with this description.'
                )
              : fileCount === 1
                ? translate(
                    'perforce.ui.newChangelistMoveOneDescription',
                    '1 file will be moved into a new changelist with this description.'
                  )
                : translate(
                    'perforce.ui.newChangelistMoveManyDescription',
                    '{{total}} files will be moved into a new changelist with this description.',
                    { total: fileCount }
                  )}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          ref={textareaRef}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={translate('perforce.ui.changelistDescription', 'Changelist description')}
          rows={4}
        />
        <DialogFooter>
          {onGenerate ? (
            <Button
              variant="outline"
              className="sm:mr-auto"
              disabled={pending || generating}
              onClick={() => void generate()}
            >
              <Sparkles />{' '}
              {generating
                ? translate('perforce.ui.generating', 'Generating…')
                : translate('perforce.ui.generateWithAi', 'Generate with AI')}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onCancel}>
            {translate('perforce.ui.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={pending || generating || description.trim().length === 0}
            onClick={() => void submit()}
          >
            {translate('perforce.ui.createChangelist', 'Create changelist')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Unshelves a shelf by changelist number (own or another user's) into the default, existing, or new changelist. */
export function UnshelveDialog({
  changelists,
  onCancel,
  onUnshelve,
  onUnshelveIntoNew
}: {
  changelists: PerforceChangelist[]
  onCancel: () => void
  onUnshelve: (source: number, target: 'default' | number) => Promise<boolean>
  onUnshelveIntoNew: (source: number, description: string) => Promise<boolean>
}) {
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('new')
  const [pending, setPending] = useState(false)
  const sourceId = Number(source)
  const valid = Number.isInteger(sourceId) && sourceId > 0
  const buildNewDescription = (): string => {
    const sourceCl = changelists.find((cl) => cl.id === sourceId)
    const firstLine = sourceCl?.description.split('\n')[0] ?? ''
    return firstLine ? `Unshelved from ${sourceId}: ${firstLine}` : `Unshelved from ${sourceId}`
  }
  const submit = async (): Promise<void> => {
    setPending(true)
    const ok =
      target === 'new'
        ? await onUnshelveIntoNew(sourceId, buildNewDescription())
        : await onUnshelve(sourceId, target === 'default' ? 'default' : Number(target))
    setPending(false)
    if (ok) {
      onCancel()
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('perforce.ui.unshelveChangelist', 'Unshelve changelist')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'perforce.ui.restoreTheShelvedFilesOfAny',
              'Restore the shelved files of any changelist, including one shelved by another user.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="p4-unshelve-source">
            {translate('perforce.ui.shelvedChangelistNumber', 'Shelved changelist number')}
          </Label>
          <Input
            id="p4-unshelve-source"
            autoFocus
            inputMode="numeric"
            value={source}
            onChange={(event) => setSource(event.target.value.trim())}
            placeholder={translate('perforce.ui.eG12345', 'e.g. 12345')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="p4-unshelve-target">{translate('perforce.ui.into', 'Into')}</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="p4-unshelve-target" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">
                {translate('perforce.ui.newChangelist', 'New changelist')}
              </SelectItem>
              <SelectItem value="default">
                {translate('perforce.ui.defaultChangelist', 'Default changelist')}
              </SelectItem>
              {changelists.map((changelist) => (
                <SelectItem key={changelist.id} value={String(changelist.id)}>
                  {perforceChangelistLabel(changelist)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {translate('perforce.ui.cancel', 'Cancel')}
          </Button>
          <Button disabled={pending || !valid} onClick={() => void submit()}>
            {translate('perforce.ui.unshelve', 'Unshelve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
