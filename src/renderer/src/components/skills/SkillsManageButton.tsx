import { useCallback } from 'react'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

function useOpenSkillManagement(): () => void {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  return useCallback((): void => {
    // Why: Settings already owns install/update terminals; the gallery stays read-only.
    openSettingsTarget({ pane: 'general', repoId: null, sectionId: 'cli' })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])
}

export function SkillsManageButton(): React.JSX.Element {
  const openSkillManagement = useOpenSkillManagement()

  return (
    <Button variant="outline" size="sm" onClick={openSkillManagement} className="shrink-0">
      <Settings className="size-3.5" />
      {translate('auto.components.skills.SkillsPage.0f54d1b7f8', 'Manage')}
    </Button>
  )
}
