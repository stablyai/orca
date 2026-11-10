import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { WorkflowWorkerAnswer } from '../../../../../shared/workflow/workflow-run-types'
import { InspectorNote, InspectorSection } from './workflow-inspector-fields'

const panelClassName =
  'max-h-96 overflow-auto text-xs leading-5 scrollbar-sleek focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset'

export function WorkflowAnswerSection({
  answer
}: {
  answer: WorkflowWorkerAnswer
}): React.JSX.Element {
  const t = useTranslate()
  const title = t(
    'auto.components.workflows.inspector.NodeExecutionInspector.answerTitle',
    'Answer'
  )
  return (
    <InspectorSection title={title}>
      <Tabs defaultValue="text" activationMode="manual">
        <TabsList size="sm" aria-label={title}>
          <TabsTrigger value="text">
            {t('auto.components.workflows.inspector.WorkflowAnswerSection.text', 'Plain text')}
          </TabsTrigger>
          <TabsTrigger value="markdown">
            {t('auto.components.workflows.inspector.WorkflowAnswerSection.markdown', 'Markdown')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="text" asChild>
          <p
            className={cn(
              panelClassName,
              'whitespace-pre-wrap',
              answer.source === 'terminal' && 'font-mono text-2xs'
            )}
          >
            {answer.text}
          </p>
        </TabsContent>
        <TabsContent value="markdown" asChild>
          <CommentMarkdown
            content={answer.text}
            className={cn(
              panelClassName,
              '[&_.comment-md-h]:mb-1 [&_.comment-md-h]:block [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-2 [&_ol]:ml-5 [&_ul]:ml-5'
            )}
          />
        </TabsContent>
      </Tabs>
      {answer.source === 'terminal' ? (
        <InspectorNote>
          {t(
            'auto.components.workflows.inspector.NodeExecutionInspector.answerFromTerminal',
            'Captured from the terminal screen because the agent’s session log could not be read.'
          )}
        </InspectorNote>
      ) : null}
      {answer.truncated ? (
        <InspectorNote>
          {t(
            'auto.components.workflows.inspector.NodeExecutionInspector.answerTruncated',
            'Earlier output was left out; open the terminal for the full history.'
          )}
        </InspectorNote>
      ) : null}
    </InspectorSection>
  )
}
