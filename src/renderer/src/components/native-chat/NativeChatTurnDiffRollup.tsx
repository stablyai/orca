import { ChevronRight } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { DiffLineCounts } from '../right-sidebar/source-control/listing/diff-line-counts'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import { NativeChatExpandable } from './NativeChatExpandable'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import {
  nativeChatTurnDiffEditFile,
  type NativeChatDiffTarget,
  type NativeChatTurnDiff,
  type NativeChatTurnDiffFile
} from './native-chat-turn-diffs'

function TurnDiffFilePatches({ file }: { file: NativeChatTurnDiffFile }): React.JSX.Element {
  return (
    <div className="pl-2">
      {file.edits.map((edit) => {
        const patch = nativeChatTurnDiffEditFile(edit)
        return patch ? (
          <NativeChatDiffCard
            key={`${edit.target.messageId}:${edit.target.editKey}:${edit.fileIndex}`}
            file={patch}
            initialOpen
            disclosureKey={`turn-diff-card:${edit.target.messageId}:${edit.target.editKey}:${edit.fileIndex}`}
          />
        ) : null
      })}
    </div>
  )
}

function TurnDiffFileRow({
  file,
  onReveal
}: {
  file: NativeChatTurnDiffFile
  onReveal: (target: NativeChatDiffTarget) => void
}): React.JSX.Element {
  const pathId = useId()
  const disclosureKey = `turn-diff:${file.edits[0]?.target.messageId}:${file.path}`
  const { open, setOpen } = useNativeChatDisclosure(disclosureKey, false)
  return (
    <div>
      <div className="flex min-w-0 items-center">
        <Button
          variant="ghost"
          size="xs"
          className="min-w-0 flex-1 justify-start"
          onClick={() => onReveal(file.target)}
        >
          <span id={pathId} className="min-w-0 truncate font-mono" title={file.path}>
            {file.path}
          </span>
          <DiffLineCounts added={file.added} removed={file.removed} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={
            open
              ? translate('components.native-chat.turnDiff.hideDiff', 'Hide diff')
              : translate('components.native-chat.turnDiff.showDiff', 'Show diff')
          }
          aria-describedby={pathId}
          title={file.path}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight aria-hidden className={open ? 'size-3.5 rotate-90' : 'size-3.5'} />
        </Button>
      </div>
      <NativeChatExpandable open={open}>
        <TurnDiffFilePatches file={file} />
      </NativeChatExpandable>
    </div>
  )
}

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
              ? translate(
                  'components.native-chat.turnDiff.changedFiles_one',
                  '{{count}} changed file',
                  {
                    count: diff.files.length
                  }
                )
              : translate(
                  'components.native-chat.turnDiff.changedFiles_other',
                  '{{count}} changed files',
                  {
                    count: diff.files.length
                  }
                )}
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
        {diff.files.map((file) => (
          <TurnDiffFileRow key={file.path} file={file} onReveal={onReveal} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
