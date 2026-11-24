import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { useTranslate } from '@/i18n/use-translate'
import type { PipelineWorkspace } from './use-pipeline-workspace'
import { PipelineRunView } from './PipelineRunView'

export function PipelineRunSheet({
  workspace,
  open,
  onOpenChange,
  onManage
}: {
  workspace: PipelineWorkspace
  open: boolean
  onOpenChange: (open: boolean) => void
  onManage?: () => void
}) {
  const t = useTranslate()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent motion="respectPreference" className="w-full sm:max-w-4xl">
        <div className="shrink-0 border-b pr-8">
          <SheetHeader>
            <SheetTitle>
              {t('pipelines.runDetails', 'Pipeline progress')} · {workspace.displayName}
            </SheetTitle>
            <SheetDescription>
              {t(
                'pipelines.runDetailsMeaning',
                'Follow stage visits and decisions. Each session link opens its saved identity.'
              )}
            </SheetDescription>
            {onManage && (
              <Button variant="outline" size="sm" className="self-start" onClick={onManage}>
                {t('pipelines.manage', 'Manage pipeline templates')}
              </Button>
            )}
          </SheetHeader>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
          <PipelineRunView workspace={workspace} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
