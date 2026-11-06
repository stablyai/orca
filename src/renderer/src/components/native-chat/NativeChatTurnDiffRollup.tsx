import { ChevronRight, EyeOff } from 'lucide-react'
import { Trans } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { i18n, translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { NATIVE_CHAT_TURN_DIFF_SETTING_SECTION_ID } from '../settings/chat/native-chat-turn-diff-setting-target'
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

function openTurnDiffSetting(): void {
  const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({
    pane: 'chat',
    repoId: null,
    sectionId: NATIVE_CHAT_TURN_DIFF_SETTING_SECTION_ID
  })
}

function HiddenToastDescription(): React.JSX.Element {
  return (
    <Trans
      i18n={i18n}
      defaults={translate(
        'components.native-chat.turnDiff.hiddenDescription',
        'You can change this anytime in <settings>Settings › Chat UI</settings>'
      )}
      components={{
        settings: (
          <button
            type="button"
            className="rounded-sm font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={openTurnDiffSetting}
          />
        )
      }}
    />
  )
}

/** Hiding turns the global setting off, so every chat drops the card; confirm only a saved change. */
async function hideTurnDiffSummaries(): Promise<void> {
  try {
    await useAppStore.getState().updateSettingsOrThrow({ nativeChatTurnDiffSummary: false })
  } catch {
    toast.error(
      translate(
        'components.native-chat.turnDiff.hideFailed',
        "Couldn't hide changed files. Try again, or turn off Changed files summary in Settings › Chat UI."
      )
    )
    return
  }
  toast(translate('components.native-chat.turnDiff.hidden', 'Hidden'), {
    description: <HiddenToastDescription />
  })
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
    <div className="group/turn-diff rounded-lg border border-chat-code-border p-2 text-xs text-chat-foreground-faint">
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
        {/* Shown on card hover or keyboard focus, like the transcript's other row actions. The
            negative margin keeps the header one text line tall, as the row-height estimate assumes. */}
        <span className="-my-1 ml-auto flex shrink-0 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover/turn-diff:pointer-events-auto group-hover/turn-diff:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={translate('components.native-chat.turnDiff.hide', 'Hide')}
                onClick={() => void hideTurnDiffSummaries()}
              >
                <EyeOff aria-hidden className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('components.native-chat.turnDiff.hide', 'Hide')}
            </TooltipContent>
          </Tooltip>
        </span>
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
