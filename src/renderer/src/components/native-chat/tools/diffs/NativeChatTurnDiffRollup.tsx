import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { NATIVE_CHAT_TURN_DIFF_SETTING_SECTION_ID } from '../../../settings/chat/native-chat-turn-diff-setting-target'
import { DiffLineCounts } from '../../../right-sidebar/source-control/listing/diff-line-counts'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import { NativeChatFileCard, nativeChatFileType } from '../../files/NativeChatFileCard'
import { useNativeChatChangedFileOpen } from '../../files/use-native-chat-changed-file-open'
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
  const t = useTranslate()
  const name = nativeChatEditFileBaseName(file.path)
  const disclosureKey = `turn-diff:${file.edits[0]?.target.messageId}:${file.path}`
  const { open, setOpen } = useNativeChatDisclosure(disclosureKey, false)
  const openAction = useNativeChatChangedFileOpen(file.path)
  return (
    <div>
      <div className="flex min-w-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-expanded={open}
          aria-label={t('components.native-chat.turnDiff.showDiff', 'Show diff: {{path}}', {
            path: file.path
          })}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight aria-hidden className={open ? 'size-3.5 rotate-90' : 'size-3.5'} />
        </Button>
        <NativeChatFileCard
          variant="row"
          path={file.path}
          name={name}
          detail={file.path.slice(0, -name.length)}
          meta={
            <>
              <DiffLineCounts added={file.added} removed={file.removed} />
              <span>
                {'· '}
                {file.deleted
                  ? t('components.native-chat.turnDiff.deleted', 'Deleted')
                  : nativeChatFileType(file.path)}
              </span>
            </>
          }
          // Deleted by this turn: nothing to open, though the chevron still shows what it removed.
          action={file.deleted ? null : openAction}
        />
      </div>
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
  const { open: showAll, setOpen: setShowAll } = useNativeChatDisclosure(
    `turn-diff-files:${diff.files[0]?.edits[0]?.target.messageId}`,
    false
  )
  const files = showAll ? diff.files : diff.files.slice(0, NATIVE_CHAT_TURN_DIFF_FILE_LIMIT)
  const remaining = diff.files.length - files.length
  return (
    <div
      className={`${NATIVE_CHAT_HIDEABLE_CARD_CLASS} rounded-lg border border-chat-code-border p-2 text-xs text-chat-foreground-faint`}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1">
        <span className="min-w-0 truncate">
          {t('components.native-chat.turnDiff.changedFiles', '{{count}} changed files', {
            count: diff.files.length,
            defaultValue_one: '{{count}} changed file'
          })}
        </span>
        <DiffLineCounts added={diff.added} removed={diff.removed} />
        {diff.truncated ? (
          <span>{t('components.native-chat.turnDiff.partial', 'Partial diff')}</span>
        ) : null}
        <NativeChatCardHideButton
          updates={{ nativeChatTurnDiffSummary: false }}
          settingSectionId={NATIVE_CHAT_TURN_DIFF_SETTING_SECTION_ID}
          hiddenMessage={t(
            'components.native-chat.turnDiff.hidden',
            "Orca won't show turn diffs anymore"
          )}
        />
      </div>
      <div className="space-y-0.5">
        {files.map((file) => (
          <TurnDiffFileRow key={file.path} file={file} />
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
