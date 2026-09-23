import { useId, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
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
import { translate } from '@/i18n/i18n'

type GiteaNewIssueDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoName: string
  onCreate: (title: string, body: string) => Promise<boolean>
}

export function GiteaNewIssueDialog({
  open,
  onOpenChange,
  repoName,
  onCreate
}: GiteaNewIssueDialogProps): React.JSX.Element {
  const titleId = useId()
  const bodyId = useId()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [creating, setCreating] = useState(false)

  const submit = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || creating) {
      return
    }
    setCreating(true)
    try {
      const ok = await onCreate(trimmed, body.trim())
      if (ok) {
        setTitle('')
        setBody('')
        onOpenChange(false)
      }
    } finally {
      // Why: always release the lock so a thrown/rejected create can't freeze the dialog.
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.gitea.new.issue.dialog.db951c3a29',
              'New issue in {{value0}}',
              {
                value0: repoName
              }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.gitea.new.issue.dialog.b42f72cfc5',
              'Create an issue in the selected Gitea project.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={titleId} className="text-xs">
              {translate('auto.components.gitea.new.issue.dialog.becfadf1df', 'Title')}
            </Label>
            <Input
              id={titleId}
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={creating}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={bodyId} className="text-xs">
              {translate('auto.components.gitea.new.issue.dialog.6c8b731fb2', 'Description')}
            </Label>
            <textarea
              id={bodyId}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              disabled={creating}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              {translate('auto.components.gitea.new.issue.dialog.032fd2ed27', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!title.trim() || creating} className="gap-2">
              {creating ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {translate('auto.components.gitea.new.issue.dialog.5e1d23a112', 'Create issue')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
