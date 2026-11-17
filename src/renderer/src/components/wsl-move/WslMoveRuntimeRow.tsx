import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { SettingsRow } from '../settings/form-controls/SettingsFormControls'
import { openWslMoveDialogFor } from './wsl-move-entry'

/** The project runtime setting of a WSL project whose distro has a host: a move, not a toggle. */
export function WslMoveRuntimeRow({
  distro,
  repoId
}: {
  distro: string
  repoId: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsRow
      label={t('wslMove.runtime.label', 'Project runtime')}
      description={t(
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
          {t('wslMove.runtime.move', 'Move project')}
        </Button>
      }
    />
  )
}
