import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { DiffLineCounts } from '../right-sidebar/source-control/listing/diff-line-counts'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import { NativeChatExpandable } from './NativeChatExpandable'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { nativeChatEditFileBaseName } from '../../../../shared/native-chat/tools/native-chat-edit-model'
import {
  nativeChatTurnDiffEditFile,
  NATIVE_CHAT_TURN_DIFF_FILE_LIMIT,
  type NativeChatTurnDiff,
  type NativeChatTurnDiffFile
} from '../../../../shared/native-chat/tools/native-chat-turn-diffs'

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

function TurnDiffFileRow({ file }: { file: NativeChatTurnDiffFile }): React.JSX.Element {
  const name = nativeChatEditFileBaseName(file.path)
  const disclosureKey = `turn-diff:${file.edits[0]?.target.messageId}:${file.path}`
  const { open, setOpen } = useNativeChatDisclosure(disclosureKey, false)
  return (
    <div>
      <Button
        variant="ghost"
        size="xs"
        className="w-full min-w-0 justify-start"
        aria-expanded={open}
        aria-label={`${file.path} +${file.added} -${file.removed}`}
        title={file.path}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight aria-hidden className={open ? 'size-3.5 rotate-90' : 'size-3.5'} />
        <span className="max-w-2/3 shrink-0 truncate font-mono text-chat-foreground">{name}</span>
        <span aria-hidden className="min-w-0 flex-1 truncate text-right font-mono">
          {file.path.slice(0, -name.length)}
        </span>
        <DiffLineCounts added={file.added} removed={file.removed} />
      </Button>
      <NativeChatExpandable open={open}>
        <TurnDiffFilePatches file={file} />
      </NativeChatExpandable>
    </div>
  )
}

export function NativeChatTurnDiffRollup({
  diff
}: {
  diff: NativeChatTurnDiff
}): React.JSX.Element {
  const { open: showAll, setOpen: setShowAll } = useNativeChatDisclosure(
    `turn-diff-files:${diff.files[0]?.edits[0]?.target.messageId}`,
    false
  )
  const files = showAll ? diff.files : diff.files.slice(0, NATIVE_CHAT_TURN_DIFF_FILE_LIMIT)
  const remaining = diff.files.length - files.length
  return (
    <div className="rounded-lg border border-chat-code-border p-2 text-xs text-chat-foreground-faint">
      <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1">
        <span className="min-w-0 truncate">
          {translate('components.native-chat.turnDiff.changedFiles', '{{count}} changed files', {
            count: diff.files.length,
            defaultValue_one: '{{count}} changed file'
          })}
        </span>
        <DiffLineCounts added={diff.added} removed={diff.removed} />
        {diff.truncated ? (
          <span>{translate('components.native-chat.turnDiff.partial', 'Partial diff')}</span>
        ) : null}
      </div>
      <div className="space-y-1">
        {files.map((file) => (
          <TurnDiffFileRow key={file.path} file={file} />
        ))}
        {remaining > 0 ? (
          <Button variant="ghost" size="xs" onClick={() => setShowAll(true)}>
            {translate('components.native-chat.turnDiff.showMoreFiles', 'Show {{count}} more', {
              count: remaining
            })}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
