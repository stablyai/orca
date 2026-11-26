import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
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
import { useTranslate } from '@/i18n/use-translate'
import { ngitApiFor } from '@/runtime/repository-ngit/ngit-owner-api'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import type { Repo } from '../../../../../shared/repository/repo-types'

export function NgitNewIssueDialog({
  repos,
  onClose,
  onCreated
}: {
  repos: Repo[]
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [publishing, setPublishing] = useState(false)
  const repo = repos.find((candidate) => candidate.id === repoId)

  const publish = async (): Promise<void> => {
    if (!repo) {
      return
    }
    setPublishing(true)
    try {
      const result = await ngitApiFor(repo).createIssue(title.trim(), body)
      if (result.ok) {
        onCreated()
        onClose()
      } else {
        toast.error(result.error)
      }
    } catch (error) {
      toast.error(readIpcErrorDetail(error) ?? String(error))
    } finally {
      setPublishing(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !publishing && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('components.taskPage.ngit.newIssue', 'New issue')}</DialogTitle>
          <DialogDescription>
            {t(
              'components.taskPage.ngit.newIssueWarning',
              'ngit signs this issue with your Nostr identity and publishes it to public relays.'
            )}
          </DialogDescription>
        </DialogHeader>
        {repos.length > 1 ? (
          <Select value={repoId} onValueChange={setRepoId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repos.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="ngit-issue-title">
            {t('components.taskPage.ngit.columnTitle', 'Title')}
          </Label>
          <Input
            id="ngit-issue-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ngit-issue-body">
            {t('components.taskPage.ngit.description', 'Description')}
          </Label>
          <Textarea
            id="ngit-issue-body"
            rows={6}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={publishing} onClick={onClose}>
            {t('components.taskPage.ngit.cancel', 'Cancel')}
          </Button>
          <Button disabled={!repo || !title.trim() || publishing} onClick={() => void publish()}>
            {publishing ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            {t('components.taskPage.ngit.publishIssue', 'Publish issue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
