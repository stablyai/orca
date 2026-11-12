import { useId } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaOrgDeleteBlocker } from '../../../../../shared/orca-org-delete'
import { TeamDeleteBlockers } from './TeamDeleteSection'
import type { TeamDeleteDialogError } from './team-delete-copy'

export type TeamDeleteDialogViewProps = {
  teamName: string
  typed: string
  submitting: boolean
  error: TeamDeleteDialogError | null
  /** 429: [Delete team] stays disabled until the wait is over. */
  waiting: boolean
  onTypedChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
  onBlockerAction: (code: OrcaOrgDeleteBlocker['code']) => void
}

/** "Delete <team>?": type the exact name (case-sensitive, paste allowed) to enable the delete. */
export function TeamDeleteDialogView(props: TeamDeleteDialogViewProps): React.JSX.Element {
  const t = useTranslate()
  const fieldId = useId()
  const mismatchId = useId()
  const matches = props.typed === props.teamName
  const canSubmit = matches && !props.submitting && !props.waiting
  const mismatch = props.error?.kind === 'mismatch' ? props.error.text : null
  return (
    <DialogContent
      showCloseButton={false}
      className="sm:max-w-md"
      onInteractOutside={(event) => {
        if (props.submitting) {
          event.preventDefault()
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {t('auto.components.billing.team.delete.confirmTitle', 'Delete {{value0}}?', {
            value0: props.teamName
          })}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.billing.team.delete.confirmBody',
            'Everyone loses access to the team. Pending invites are cancelled. Its settings and team cloud secrets are deleted. Billing history is kept. This can’t be undone.'
          )}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) {
            props.onSubmit()
          }
        }}
      >
        <Label htmlFor={fieldId}>
          {t('auto.components.billing.team.delete.typeToConfirm', 'Type {{value0}} to confirm', {
            value0: props.teamName
          })}
        </Label>
        <Input
          id={fieldId}
          value={props.typed}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-invalid={mismatch ? true : undefined}
          aria-describedby={mismatch ? mismatchId : undefined}
          onChange={(event) => props.onTypedChange(event.target.value)}
        />
        {mismatch ? (
          <p id={mismatchId} className="text-xs text-destructive-text">
            {mismatch}
          </p>
        ) : null}
      </form>
      {props.error?.kind === 'blocked' ? (
        <div role="alert">
          <TeamDeleteBlockers blockers={props.error.blockers} onAction={props.onBlockerAction} />
        </div>
      ) : props.error?.kind === 'message' ? (
        <p role="alert" className="text-xs text-destructive-text text-pretty">
          {props.error.text}
        </p>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={props.submitting}
          onClick={props.onCancel}
        >
          {t('auto.components.confirmation.dialog.56f5c60e0c', 'Cancel')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!canSubmit}
          aria-busy={props.submitting || undefined}
          onClick={props.onSubmit}
        >
          {props.submitting ? <LoaderCircle className="motion-safe:animate-spin" /> : null}
          {t('auto.components.billing.team.delete.cta', 'Delete team')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
