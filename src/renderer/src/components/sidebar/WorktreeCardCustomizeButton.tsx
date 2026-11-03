import React from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/** Opens the Card Studio on this workspace's card, from the Workspace menu's header. */
export function WorktreeCardCustomizeButton({
  worktreeId,
  onOpen
}: {
  worktreeId: string
  onOpen: () => void
}): React.JSX.Element {
  const openCardStudio = useAppStore((s) => s.openCardStudio)
  return (
    <Button
      variant="ghost"
      size="xs"
      data-worktree-card-customize=""
      onClick={() => {
        onOpen()
        openCardStudio(worktreeId)
      }}
    >
      <Sparkles />
      {translate('auto.components.sidebar.WorktreeContextMenu.customize', 'Customize')}
    </Button>
  )
}
