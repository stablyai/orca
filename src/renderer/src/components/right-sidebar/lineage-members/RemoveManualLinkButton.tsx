import React, { useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type RemoveManualLinkButtonProps = {
  parentWorkspaceKey: string
  linkId: string
  label: string
  onChanged: () => void
}

/** Removes something added to the tower by hand; the same control in Checks and Source Control. */
export function RemoveManualLinkButton({
  parentWorkspaceKey,
  linkId,
  label,
  onChanged
}: RemoveManualLinkButtonProps): React.JSX.Element {
  const [removing, setRemoving] = useState(false)
  const title = `${translate('auto.components.rightSidebar.lineageMembers.removePullRequest', 'Remove')} ${label}`
  const failed = translate(
    'auto.components.rightSidebar.lineageMembers.removeFailed',
    'Could not remove {{label}}',
    { label }
  )
  const remove = async (): Promise<void> => {
    setRemoving(true)
    try {
      const result = await window.api.git.lineageRemoveManualLink({ parentWorkspaceKey, linkId })
      if (result.success) {
        onChanged()
      } else {
        toast.error(failed)
      }
    } catch (err) {
      toast.error(failed, { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setRemoving(false)
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={title}
      title={title}
      disabled={removing}
      onClick={() => void remove()}
    >
      <X className="size-3.5" />
    </Button>
  )
}
