import React from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { SettingsRow } from '../settings/SettingsFormControls'
import { openWslMoveDialogFor } from './wsl-move-entry'

/** The project runtime setting of a WSL project whose distro has a host: a move, not a toggle. */
export function WslMoveRuntimeRow({
  distro,
  repoId
}: {
  distro: string
  repoId: string
}): React.JSX.Element {
  return (
    <SettingsRow
      label={translate('wslMove.runtime.label', 'Project runtime')}
      description={translate(
        'wslMove.runtime.description',
        'This project runs in {{distro}} through this computer. Move it to the {{distro}} host to run it there.',
        { distro }
      )}
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openWslMoveDialogFor(distro, { kind: 'repo', id: repoId })}
        >
          {translate('wslMove.runtime.move', 'Move project')}
        </Button>
      }
    />
  )
}
