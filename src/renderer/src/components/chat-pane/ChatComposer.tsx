import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Mic, Paperclip, Plug, Plus, Puzzle, Slash, Square, Type } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { JcodeChatAttachment, JcodeCustomProvider } from '../../../../shared/jcode-chat-types'
import { SLASH_COMMANDS } from './chat-slash-commands'
import { useChatSlashMenu } from './use-chat-slash-menu'
import { ChatAttachmentChips, SkillChip, SlashCommandPopover } from './ChatComposerExtras'
import { ChatModelPicker } from './ChatModelPicker'

// Why: the composer is the Claude-app-style bottom bar. It owns the unsent
// draft text (local state) and the auto-growing textarea, but the provider/model
// selection AND the pending attachments are lifted to the chat-session-store via
// props so they persist per sessionKey across tab switches. Keeping it a
// separate component keeps ChatPane focused on the message list + send wiring.

// Pasted text larger than this is auto-converted into a collapsible text
// attachment chip instead of bloating the textarea.
const LARGE_PASTE_THRESHOLD = 1200

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  provider,
  providerProfile,
  model,
  customProviders,
  onSelectProvider,
  attachments,
  onAddFiles,
  onAddText,
  onRemoveAttachment,
  onSlashAction,
  cwd,
  worktreeId,
  selectedSkillName,
  onSelectSkill
}: {
  value: string
  onChange: (next: string) => void
  onSend: () => void
  onStop: () => void
  isStreaming: boolean
  /** Selected built-in provider id, or undefined for "Auto"/profile. */
  provider: string | undefined
  /** Selected custom provider profile name, or undefined. Mutually exclusive
   *  with `provider`. */
  providerProfile?: string | undefined
  model: string | undefined
  /** User-added custom OpenAI-compatible profiles to surface in the picker. */
  customProviders?: JcodeCustomProvider[]
  onSelectProvider: (selection: {
    provider?: string | undefined
    providerProfile?: string | undefined
    model?: string | undefined
  }) => void
  /** Pending attachments for the next turn (files + text blobs). */
  attachments: JcodeChatAttachment[]
  /** Open the native file picker and attach the chosen absolute paths. */
  onAddFiles: () => void
  /** Attach a text blob (from "Add text" or a large paste). */
  onAddText: (content: string, name?: string) => void
  /** Remove a pending attachment by index. */
  onRemoveAttachment: (index: number) => void
  /** Run an orca-side "/" action (start new chat / reopen last). */
  onSlashAction: (action: 'clear' | 'resume') => void
  /** FEATURE B: project root + worktree for skill discovery, the skill armed for
   *  the next send (shows a chip; null = none), and the arm/disarm callback. */
  cwd?: string
  worktreeId?: string
  selectedSkillName?: string | null
  onSelectSkill: (skillName: string | null) => void
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // "+menu" navigation: Connectors -> the MCP settings section; Plugins -> Skills.
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSkillsPage = useAppStore((s) => s.openSkillsPage)

  // FEATURE B: the "/" menu (orca quick commands + skills) is owned by the hook;
  // selecting a skill row arms it via onSelectSkill.
  const {
    slashOpen,
    slashIndex,
    setSlashIndex,
    setSlashOpen,
    commands: slashCommandRows,
    skills: slashSkillRows,
    flatMatches,
    degraded: skillsDegraded,
    runSlashCommand
  } = useChatSlashMenu({
    value,
    cwd,
    worktreeId,
    textareaRef,
    onChange,
    onSlashAction,
    onSelectSkill
  })

  // Auto-grow the textarea up to a max height, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex flex-col gap-1 rounded-2xl border border-input bg-background px-3 py-2 shadow-sm transition-colors focus-within:border-ring">
        {/* Attachment chips above the textarea. */}
        <ChatAttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />

        {/* FEATURE B: armed-skill chip (the skill body is injected on send). */}
        <SkillChip name={selectedSkillName} onRemove={() => onSelectSkill(null)} />

        <div className="relative">
          {slashOpen ? (
            <SlashCommandPopover
              commands={slashCommandRows}
              skills={slashSkillRows}
              activeIndex={slashIndex}
              onHover={setSlashIndex}
              onPick={runSlashCommand}
              degraded={skillsDegraded}
            />
          ) : null}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onPaste={(event) => {
              // Auto-convert a very large paste into a collapsible text attachment
              // so big content doesn't bloat the input box.
              const text = event.clipboardData.getData('text')
              if (text && text.length > LARGE_PASTE_THRESHOLD) {
                event.preventDefault()
                const firstLine = text.split('\n', 1)[0].trim().slice(0, 40)
                onAddText(text, firstLine ? `Pasted: ${firstLine}…` : 'Pasted text')
              }
            }}
            onKeyDown={(event) => {
              // Slash menu keyboard nav takes priority while open.
              if (slashOpen && flatMatches.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setSlashIndex((i) => (i + 1) % flatMatches.length)
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSlashIndex((i) => (i - 1 + flatMatches.length) % flatMatches.length)
                  return
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault()
                  runSlashCommand(flatMatches[slashIndex])
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setSlashOpen(false)
                  return
                }
              }
              // Why (BUG 3, IME): guard the Enter-to-send against IME composition.
              // While composing Chinese/Japanese/etc., pressing Enter COMMITS the
              // candidate — it must not trigger a send. `isComposing`/keyCode 229
              // mark an in-progress composition; firing onSend() there both sends a
              // half-typed prompt AND lets compositionend re-fill the textarea after
              // ChatPane's setInput('') runs, so the box still shows text. Skipping
              // send during composition fixes both the premature send and the
              // text-not-cleared symptom.
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault()
                onSend()
              }
            }}
            placeholder="Message jcode…  (type / for commands)"
            rows={1}
            className="max-h-[200px] w-full resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex items-center gap-1.5">
          {/* "+" menu */}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Add to message"
                className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[14rem]">
              <DropdownMenuItem
                onSelect={() => {
                  // Defer so the menu closes before the OS dialog opens.
                  window.requestAnimationFrame(() => onAddFiles())
                }}
              >
                <Paperclip className="size-4" />
                Add files
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  window.requestAnimationFrame(() => {
                    const text = window.prompt('Paste or type text to attach:')
                    if (text && text.trim()) {
                      const firstLine = text.split('\n', 1)[0].trim().slice(0, 40)
                      onAddText(text, firstLine ? firstLine : 'Text')
                    }
                  })
                }}
              >
                <Type className="size-4" />
                Add text
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Slash className="size-4" />
                  Quick commands
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[16rem]">
                  {SLASH_COMMANDS.map((command) => (
                    <DropdownMenuItem key={command.id} onSelect={() => runSlashCommand(command)}>
                      <span className="font-medium">{command.label}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{command.hint}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  openSettingsTarget({
                    pane: 'accounts',
                    repoId: null,
                    sectionId: 'accounts-jcode-mcp'
                  })
                  openSettingsPage()
                }}
              >
                <Plug className="size-4" />
                连接器 / Connectors
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openSkillsPage()}>
                <Puzzle className="size-4" />
                技能 / Skills
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Provider / model chip ("Auto" by default) — detailed picker. */}
          <ChatModelPicker
            provider={provider}
            providerProfile={providerProfile}
            model={model}
            customProviders={customProviders}
            onSelectProvider={onSelectProvider}
          />

          <div className="flex-1" />

          {/* Mic / voice — disabled until a speech skill is wired in. */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={-1}>
                  <button
                    type="button"
                    disabled
                    aria-label="Voice input"
                    className="flex size-8 cursor-not-allowed items-center justify-center rounded-full text-muted-foreground opacity-50"
                  >
                    <Mic className="size-4" />
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent>语音转写需安装语音技能</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Send / Stop */}
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              className="flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!value.trim() && attachments.length === 0 && !selectedSkillName}
              aria-label="Send"
              className={cn(
                'flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity',
                'disabled:cursor-not-allowed disabled:opacity-40'
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
