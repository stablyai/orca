import { useState } from 'react'
import { CalendarDays, FileCode2, KanbanSquare, MessageSquareText } from 'lucide-react'
import { Card } from '../ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { createGithubIssuePipelineTask } from '../../../../shared/pipeline/pipeline-task'
import { useWorkbenchPipeline } from './use-workbench-pipeline'
import { WorkbenchAutomationBar } from './workbench-automation-bar'
import { WorkbenchDialoguePanel } from './workbench-dialogue-panel'
import { WorkbenchKanbanPanel } from './workbench-kanban-panel'
import { WorkbenchSchedulePanel } from './workbench-schedule-panel'

export default function WorkbenchPage(): React.JSX.Element {
  const t = useTranslate()
  const [tab, setTab] = useState('dialogue')
  const {
    entries,
    activeEntry,
    stages,
    hasRepo,
    repoId,
    startTask,
    selectTask,
    dispatchEvent,
    runCheckGate,
    runReview,
    runCiWatch,
    runMerge,
    openWorktree
  } = useWorkbenchPipeline()

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-background p-3">
      <WorkbenchAutomationBar stages={stages} />
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
          <WorkbenchKanbanPanel
            onStartIssue={
              repoId
                ? (issue) => {
                    const task = createGithubIssuePipelineTask(repoId, issue)
                    setTab('dialogue')
                    void startTask(task)
                  }
                : undefined
            }
          />
        </TabsContent>
        <TabsContent value="dialogue" className="flex min-h-0 flex-1 flex-col">
          <WorkbenchDialoguePanel
            entries={entries}
            activeTaskId={activeEntry?.task.id ?? null}
            hasRepo={hasRepo}
            onStartTask={startTask}
            onSelectTask={selectTask}
            onDispatchEvent={dispatchEvent}
            onRunCheckGate={runCheckGate}
            onRunReview={runReview}
            onRunCiWatch={runCiWatch}
            onRunMerge={runMerge}
            onOpenWorktree={openWorktree}
          />
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
