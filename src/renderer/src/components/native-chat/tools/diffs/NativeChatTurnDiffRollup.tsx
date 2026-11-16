import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { NATIVE_CHAT_TURN_DIFF_SETTING_SECTION_ID } from '../../../settings/chat/native-chat-turn-diff-setting-target'
import { DiffLineCounts } from '../../../right-sidebar/source-control/listing/diff-line-counts'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import { NativeChatExpandable } from '../../messages/disclosure/NativeChatExpandable'
import {
  NativeChatCardHideButton,
  NATIVE_CHAT_HIDEABLE_CARD_CLASS
} from '../../messages/disclosure/NativeChatCardHideButton'
import { useNativeChatDisclosure } from '../../messages/disclosure/native-chat-disclosure-store'
import { nativeChatEditFileBaseName } from '../../../../../../shared/native-chat/tools/native-chat-edit-model'
import {
  nativeChatTurnDiffEditFile,
  NATIVE_CHAT_TURN_DIFF_FILE_LIMIT,
  type NativeChatTurnDiff,
  type NativeChatTurnDiffFile
} from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { useNativeChatTurnDiffGitState } from './use-native-chat-turn-diff-git-state'

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
  uncommitted
}: {
  file: NativeChatTurnDiffFile
  uncommitted: boolean
}): React.JSX.Element {
  const t = useTranslate()
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
        {uncommitted ? (
          <span className="shrink-0 text-chat-warning">
            {t('components.native-chat.turnDiff.fileUncommitted', 'uncommitted')}
          </span>
        ) : null}
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
  const t = useTranslate()
  const git = useNativeChatTurnDiffGitState(diff)
  const { open: showAll, setOpen: setShowAll } = useNativeChatDisclosure(
    `turn-diff-files:${diff.files[0]?.edits[0]?.target.messageId}`,
    false
  )
  const files = showAll ? diff.files : diff.files.slice(0, NATIVE_CHAT_TURN_DIFF_FILE_LIMIT)
  const remaining = diff.files.length - files.length
  const committedState =
    git === null || git.committedCount === 0
      ? null
      : git.allPushed === true
        ? t('components.native-chat.turnDiff.pushed', 'pushed')
        : git.allPushed === false
          ? t('components.native-chat.turnDiff.unpushed', 'committed · unpushed')
          : t('components.native-chat.turnDiff.committed', 'committed')
  return (
    <div
      className={`${NATIVE_CHAT_HIDEABLE_CARD_CLASS} rounded-lg border border-chat-code-border p-2 text-xs text-chat-foreground-faint`}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1">
        <span className="min-w-0 truncate">
          {t('components.native-chat.turnDiff.filesEdited', '{{count}} files edited', {
            count: diff.files.length,
            defaultValue_one: '{{count}} file edited'
          })}
        </span>
        <DiffLineCounts added={diff.added} removed={diff.removed} />
        {diff.truncated ? (
          <span>{t('components.native-chat.turnDiff.partial', 'Partial diff')}</span>
        ) : null}
        {git !== null && git.uncommittedCount > 0 ? (
          <span className="shrink-0 text-chat-warning">
            {t('components.native-chat.turnDiff.uncommitted', '{{count}} uncommitted', {
              count: git.uncommittedCount,
              defaultValue_one: '{{count}} uncommitted'
            })}
          </span>
        ) : null}
        {committedState !== null ? <span className="shrink-0">{committedState}</span> : null}
        <NativeChatCardHideButton
          updates={{ nativeChatTurnDiffSummary: false }}
          settingSectionId={NATIVE_CHAT_TURN_DIFF_SETTING_SECTION_ID}
          hiddenMessage={t(
            'components.native-chat.turnDiff.hidden',
            "Orca won't show turn diffs anymore"
          )}
        />
      </div>
      <div className="space-y-1">
        {files.map((file) => (
          <TurnDiffFileRow
            key={file.path}
            file={file}
            uncommitted={git?.uncommittedPaths.has(file.path) === true}
          />
        ))}
        {remaining > 0 ? (
          <Button variant="ghost" size="xs" onClick={() => setShowAll(true)}>
            {t('components.native-chat.turnDiff.showMoreFiles', 'Show {{count}} more', {
              count: remaining
            })}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
