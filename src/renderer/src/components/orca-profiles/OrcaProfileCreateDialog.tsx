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
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

export function OrcaProfileCreateDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  creating,
  switching,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  onNameChange: (name: string) => void
  creating: boolean
  switching: boolean
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <form onSubmit={onSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.orca.profiles.switcher.16e3681072', 'New local profile')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.orca.profiles.switcher.e3b91a3d90',
                'Create an empty profile for separate projects and worktrees.'
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={translate(
              'auto.components.orca.profiles.switcher.f322e1f4d6',
              'Profile name'
            )}
            maxLength={80}
          />
          <DialogFooter>
            <Button type="submit" size="sm" disabled={creating || switching}>
              {creating || switching ? <Loader2 className="size-4 animate-spin" /> : null}
              {translate('auto.components.orca.profiles.switcher.cfa59f8ad1', 'Create and Switch')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
