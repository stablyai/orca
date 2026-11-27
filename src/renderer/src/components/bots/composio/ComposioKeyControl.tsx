// The owner's Composio key where it's managed: the paste step when there's none (or Composio refused
// it), else one compact line with Change and Remove. One key serves every bot on this computer.
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { ComposioKeyForm } from './ComposioKeyForm'
import { useComposioKey } from './composio-key-client'
import { useRemoveComposioKey } from './composio-remove-key-confirm'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

export function ComposioKeyControl({
  hostId
}: {
  hostId: ExecutionHostId
}): React.JSX.Element | null {
  const t = useTranslate()
  const key = useComposioKey(hostId)
  const [changing, setChanging] = useState(false)
  const removeKey = useRemoveComposioKey(hostId)
  if (!key) {
    return null
  }
  if (key.key !== 'ok' || changing) {
    return (
      <div className="flex flex-col gap-1">
        {key.key === 'rejected' ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'bots.composio.key.rejectedLine',
              'Composio no longer accepts the saved key. Paste a new one.'
            )}
          </p>
        ) : null}
        <ComposioKeyForm
          hostId={hostId}
          replacing={key.key !== 'none'}
          onSaved={() => setChanging(false)}
          onCancel={changing ? () => setChanging(false) : undefined}
        />
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {key.hint
          ? t('bots.composio.key.line', 'Composio key · ends in {{hint}}', {
              hint: key.hint
            })
          : t('bots.composio.key.lineNoHint', 'Composio key')}
      </span>
      <Button size="xs" variant="ghost" onClick={() => setChanging(true)}>
        {t('bots.composio.key.change', 'Change')}
      </Button>
      <Button size="xs" variant="ghost" onClick={() => void removeKey()}>
        {t('bots.composio.remove', 'Remove')}
      </Button>
    </div>
  )
}
