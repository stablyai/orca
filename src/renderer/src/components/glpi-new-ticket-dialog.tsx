import { useId, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
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
import { translate } from '@/i18n/i18n'

type GlpiTicketType = 'incident' | 'request'

type GlpiNewTicketDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverName?: string
  onCreate: (input: { title: string; content: string; type: GlpiTicketType }) => Promise<boolean>
}

type CreateState = 'idle' | 'creating' | 'error'

// Why: GLPI tickets are not tied to a repo, so creation is a simple title +
// description + incident/request form rather than the repo-scoped issue flow.
export function GlpiNewTicketDialog({
  open,
  onOpenChange,
  serverName,
  onCreate
}: GlpiNewTicketDialogProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const titleId = useId()
  const contentId = useId()
  const typeId = useId()
  const errorId = useId()

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [type, setType] = useState<GlpiTicketType>('incident')
  const [createState, setCreateState] = useState<CreateState>('idle')
  const [createError, setCreateError] = useState<string | null>(null)

  const canSubmit = Boolean(title.trim()) && createState !== 'creating'

  const clearErrorOnEdit = (): void => {
    if (createState === 'error') {
      setCreateState('idle')
      setCreateError(null)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (createState !== 'creating') {
      onOpenChange(nextOpen)
    }
  }

  const handleCreate = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || createState === 'creating') {
      return
    }
    setCreateState('creating')
    setCreateError(null)
    try {
      const created = await onCreate({ title: trimmedTitle, content: content.trim(), type })
      if (!mountedRef.current) {
        return
      }
      if (created) {
        setTitle('')
        setContent('')
        setType('incident')
        setCreateState('idle')
        onOpenChange(false)
        return
      }
      setCreateState('error')
      setCreateError(
        translate(
          'auto.components.glpi.new.ticket.dialog.7872b123a3',
          'Could not create the ticket. Check your GLPI access and try again.'
        )
      )
    } catch (error) {
      if (mountedRef.current) {
        setCreateState('error')
        setCreateError(error instanceof Error ? error.message : 'Could not create the ticket')
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {translate('auto.components.glpi.new.ticket.dialog.5f3261ec55', 'New GLPI ticket')}
          </DialogTitle>
          <DialogDescription>
            {serverName
              ? translate(
                  'auto.components.glpi.new.ticket.dialog.179aa5cc53',
                  'Create a ticket on {{value0}}.',
                  { value0: serverName }
                )
              : translate(
                  'auto.components.glpi.new.ticket.dialog.021dceec54',
                  'Create a ticket in GLPI.'
                )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleCreate()
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="space-y-2">
              <Label htmlFor={titleId} className="text-xs">
                {translate('auto.components.glpi.new.ticket.dialog.222533c970', 'Title')}
              </Label>
              <Input
                id={titleId}
                autoFocus
                placeholder={translate(
                  'auto.components.glpi.new.ticket.dialog.df4b3592d1',
                  'Short summary of the issue'
                )}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={createState === 'creating'}
                aria-invalid={createState === 'error'}
                aria-describedby={createState === 'error' ? errorId : undefined}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={contentId} className="text-xs">
                {translate('auto.components.glpi.new.ticket.dialog.ecfea19759', 'Description')}
              </Label>
              <textarea
                id={contentId}
                rows={4}
                placeholder={translate(
                  'auto.components.glpi.new.ticket.dialog.7a43b31780',
                  'Add any detail that helps resolve the ticket'
                )}
                value={content}
                onChange={(event) => {
                  setContent(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={createState === 'creating'}
                className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={typeId} className="text-xs">
                {translate('auto.components.glpi.new.ticket.dialog.6647218333', 'Type')}
              </Label>
              <Select
                value={type}
                onValueChange={(value) => {
                  setType(value as GlpiTicketType)
                  clearErrorOnEdit()
                }}
                disabled={createState === 'creating'}
              >
                <SelectTrigger id={typeId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="incident">
                    {translate('auto.components.glpi.new.ticket.dialog.5d83457bb5', 'Incident')}
                  </SelectItem>
                  <SelectItem value="request">
                    {translate('auto.components.glpi.new.ticket.dialog.6f3e248e04', 'Request')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {createState === 'error' && createError ? (
              <p id={errorId} className="text-xs text-destructive">
                {createError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={createState === 'creating'}
            >
              {translate('auto.components.glpi.new.ticket.dialog.ed88ae4924', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {createState === 'creating' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.glpi.new.ticket.dialog.2a3003f1fc', 'Creating…')}
                </>
              ) : (
                translate('auto.components.glpi.new.ticket.dialog.0e2f43e33a', 'Create ticket')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
