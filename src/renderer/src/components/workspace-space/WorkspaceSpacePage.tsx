import { ArrowLeft } from 'lucide-react'
import { Button } from '../ui/button'
import { WorkspaceSpaceManagerPanel } from '../status-bar/WorkspaceSpaceManagerPanel'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

export default function WorkspaceSpacePage(): React.JSX.Element {
  const closeSpacePage = useAppStore((state) => state.closeSpacePage)
  const isSeparateWindow = window.location.pathname.endsWith('/space.html')

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background p-3">
      {!isSeparateWindow ? (
        <Button variant="ghost" size="xs" onClick={closeSpacePage} className="mb-2 w-fit">
          <ArrowLeft className="size-3.5" />
          {translate('auto.components.workspace.space.WorkspaceSpacePage.ecf72fdc3b', 'Back')}
        </Button>
      ) : null}
      <div className="mx-auto flex min-h-0 w-full max-w-[96rem] flex-1 flex-col">
        <WorkspaceSpaceManagerPanel />
      </div>
    </div>
  )
}
