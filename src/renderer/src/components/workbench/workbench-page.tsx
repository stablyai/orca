import { useState } from 'react'
import { CalendarDays, FileCode2, KanbanSquare, MessageSquareText } from 'lucide-react'
import { Card } from '../ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { WorkbenchAutomationBar } from './workbench-automation-bar'
import { WorkbenchKanbanPanel } from './workbench-kanban-panel'
import { WorkbenchSchedulePanel } from './workbench-schedule-panel'

export default function WorkbenchPage(): React.JSX.Element {
  const t = useTranslate()
  const [tab, setTab] = useState('schedule')

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-background p-3">
      <WorkbenchAutomationBar
        stages={[
          { id: 'triage', status: 'pass' },
          { id: 'approval', status: 'active' },
          { id: 'fix', status: 'idle' },
          { id: 'review', status: 'idle' },
          { id: 'ci', status: 'idle' },
          { id: 'merge', status: 'idle' }
        ]}
      />
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-fit">
          <TabsTrigger value="schedule">
            <CalendarDays className="size-4" />
            {t('auto.components.workbench.tabs.schedule', 'Schedule')}
          </TabsTrigger>
          <TabsTrigger value="kanban">
            <KanbanSquare className="size-4" />
            {t('auto.components.workbench.tabs.kanban', 'Board')}
          </TabsTrigger>
          <TabsTrigger value="dialogue">
            <MessageSquareText className="size-4" />
            {t('auto.components.workbench.tabs.dialogue', 'Dialogue')}
          </TabsTrigger>
          <TabsTrigger value="editor">
            <FileCode2 className="size-4" />
            {t('auto.components.workbench.tabs.editor', 'Editor')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="schedule" className="flex min-h-0 flex-1 flex-col">
          <WorkbenchSchedulePanel />
        </TabsContent>
        <TabsContent value="kanban" className="flex min-h-0 flex-1 flex-col">
          <WorkbenchKanbanPanel />
        </TabsContent>
        <TabsContent value="dialogue" className="flex min-h-0 flex-1 flex-col">
          <Card className="p-3 text-sm text-muted-foreground">
            {t(
              'auto.components.workbench.dialogue.hint',
              'Dialogue reuses the existing NativeChat session in the workspace.'
            )}
          </Card>
        </TabsContent>
        <TabsContent value="editor" className="flex min-h-0 flex-1 flex-col">
          <Card className="p-3 text-sm text-muted-foreground">
            {t(
              'auto.components.workbench.editor.hint',
              'Editor reuses the workspace Monaco surface; open a worktree to edit.'
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
