import { FileText, Paperclip, Puzzle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { JcodeChatAttachment } from '../../../../shared/jcode-chat-types'
import type { SlashCommand } from './chat-slash-commands'

/** A short, human label for an attachment chip. */
function attachmentLabel(attachment: JcodeChatAttachment): string {
  return (
    attachment.name ||
    (attachment.kind === 'file'
      ? attachment.path
      : translate('jcode.chat.attachment.defaultTextName', 'Text'))
  )
}

/** Removable chips for the composer's pending attachments (files + text blobs),
 *  rendered above the textarea. Renders nothing when there are no attachments. */
export function ChatAttachmentChips({
  attachments,
  onRemove
}: {
  attachments: JcodeChatAttachment[]
  onRemove: (index: number) => void
}): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null
  }
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1">
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.kind}-${index}-${attachmentLabel(attachment)}`}
          className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground"
          title={attachment.kind === 'file' ? attachment.path : attachment.name}
        >
          {attachment.kind === 'file' ? (
            <Paperclip className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <FileText className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{attachmentLabel(attachment)}</span>
          <button
            type="button"
            aria-label={translate('jcode.chat.attachment.removeAria', 'Remove attachment')}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            onClick={() => onRemove(index)}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  )
}

/** One selectable row inside the slash popover. `index` is the FLAT index across
 *  both groups so keyboard nav (activeIndex) works uniformly. */
function SlashRow({
  command,
  index,
  activeIndex,
  onHover,
  onPick
}: {
  command: SlashCommand
  index: number
  activeIndex: number
  onHover: (index: number) => void
  onPick: (command: SlashCommand) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors',
        index === activeIndex ? 'bg-muted' : 'hover:bg-muted'
      )}
      onMouseEnter={() => onHover(index)}
      onMouseDown={(event) => {
        // mousedown so the textarea doesn't lose focus before we act.
        event.preventDefault()
        onPick(command)
      }}
    >
      <span className="truncate font-medium">{command.label}</span>
      <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{command.hint}</span>
    </button>
  )
}

/** FEATURE B: a chip for the skill armed for the next send. Its SKILL.md body is
 *  injected into the prompt by the main process; this only shows the name + a ✕
 *  to disarm. Renders nothing when no skill is armed. */
export function SkillChip({
  name,
  onRemove
}: {
  name: string | null | undefined
  onRemove: () => void
}): React.JSX.Element | null {
  if (!name) {
    return null
  }
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1">
      <span className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-foreground">
        <Puzzle className="size-3 shrink-0 text-primary" />
        <span className="truncate">
          {translate('jcode.chat.skillChip.prefix', 'Skill:')} {name}
        </span>
        <button
          type="button"
          aria-label={translate('jcode.chat.skillChip.removeAria', 'Remove skill')}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  )
}

/** The "/"-triggered popover, anchored above the textarea. Renders two grouped
 *  sections — orca quick commands + project/global skills — with a single FLAT
 *  active index so ↑/↓ moves across both. The flat order is `commands` then
 *  `skills`; the caller computes activeIndex against that same concatenation. */
export function SlashCommandPopover({
  commands,
  skills,
  activeIndex,
  onHover,
  onPick,
  degraded
}: {
  commands: SlashCommand[]
  skills: SlashCommand[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (command: SlashCommand) => void
  /** True when a remote project's project-local skills could not be read. */
  degraded?: boolean
}): React.JSX.Element {
  return (
    <div className="absolute bottom-full left-0 z-20 mb-1 max-h-72 w-full max-w-sm overflow-y-auto scrollbar-sleek rounded-lg border border-border bg-popover shadow-md">
      {commands.length > 0 ? (
        <>
          <div className="border-b border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {translate('jcode.chat.slash.commandsHeading', 'Orca quick commands')}
          </div>
          {commands.map((command, i) => (
            <SlashRow
              key={command.id}
              command={command}
              index={i}
              activeIndex={activeIndex}
              onHover={onHover}
              onPick={onPick}
            />
          ))}
        </>
      ) : null}
      {skills.length > 0 ? (
        <>
          <div className="border-y border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {translate('jcode.chat.slash.skillsHeading', 'Skills')}
          </div>
          {skills.map((command, i) => (
            <SlashRow
              key={command.id}
              command={command}
              // Flat index continues after the commands group.
              index={commands.length + i}
              activeIndex={activeIndex}
              onHover={onHover}
              onPick={onPick}
            />
          ))}
        </>
      ) : null}
      {degraded ? (
        <div className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {translate(
            'jcode.chat.slash.projectSkillsUnavailable',
            'Project skills on the remote host were unavailable; showing global skills only.'
          )}
        </div>
      ) : null}
    </div>
  )
}
