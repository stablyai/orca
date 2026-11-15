import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function ChecksPanelUnlinkedPullRequest({
  number,
  onRelink
}: {
  number: number | null
  onRelink: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="px-4 py-6">
      <div className="text-sm font-medium text-foreground">
        {t('checksPanel.unlinked.title', 'Pull request unlinked')}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t(
          'checksPanel.unlinked.description',
          'PR #{{number}} is hidden for this workspace. Link it again to restore checks and review details.',
          { number }
        )}
      </div>
      <Button size="xs" className="mt-3" onClick={onRelink}>
        {t('checksPanel.unlinked.relink', 'Link PR #{{number}}', { number })}
      </Button>
    </div>
  )
}
