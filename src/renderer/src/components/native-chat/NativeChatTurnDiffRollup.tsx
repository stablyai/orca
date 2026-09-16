import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { DiffLineCounts } from '../right-sidebar/source-control/listing/diff-line-counts'
import type { NativeChatDiffTarget, NativeChatTurnDiff } from './native-chat-turn-diffs'

export function NativeChatTurnDiffRollup({
  diff,
  onReveal
}: {
  diff: NativeChatTurnDiff
  onReveal: (target: NativeChatDiffTarget) => void
}): React.JSX.Element {
  return (
    <Collapsible className="text-xs text-muted-foreground">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="group w-full min-w-0 justify-start gap-1.5">
          <span className="min-w-0 truncate">
            {diff.files.length === 1
              ? translate('components.native-chat.turnDiff.one', '1 changed file')
              : translate('components.native-chat.turnDiff.many', '{{count}} changed files', {
                  count: diff.files.length
                })}
          </span>
          <DiffLineCounts added={diff.added} removed={diff.removed} />
          {diff.truncated ? (
            <span>{translate('components.native-chat.turnDiff.partial', 'Partial diff')}</span>
          ) : null}
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 space-y-1 pl-4">
        <p className="px-2">
          {translate(
            'components.native-chat.turnDiff.recorded',
            'Totals from recorded edits in this turn.'
          )}
        </p>
        {diff.files.map((file) => (
          <Button
            key={file.path}
            variant="ghost"
            size="xs"
            className="flex w-full justify-start gap-2"
            onClick={() => onReveal(file.target)}
          >
            <span className="min-w-0 truncate font-mono" title={file.path}>
              {file.path}
            </span>
            <DiffLineCounts added={file.added} removed={file.removed} />
          </Button>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
