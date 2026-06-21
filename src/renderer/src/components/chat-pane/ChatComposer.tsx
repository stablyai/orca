import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  Mic,
  Paperclip,
  Plug,
  Plus,
  Puzzle,
  Slash,
  Square,
  Type
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { JcodeChatAttachment, JcodeCustomProvider } from '../../../../shared/jcode-chat-types'
import {
  JCODE_PROVIDERS,
  buildProfileOptions,
  findProfileOption,
  findProviderOption
} from './jcode-providers'
import { SLASH_COMMANDS, filterSlashCommands, type SlashCommand } from './chat-slash-commands'
import { ChatAttachmentChips, SlashCommandPopover } from './ChatComposerExtras'

// Why: the composer is the Claude-app-style bottom bar. It owns the unsent
// draft text (local state) and the auto-growing textarea, but the provider/model
// selection AND the pending attachments are lifted to the chat-session-store via
// props so they persist per sessionKey across tab switches. Keeping it a
// separate component keeps ChatPane focused on the message list + send wiring.

// Pasted text larger than this is auto-converted into a collapsible text
// attachment chip instead of bloating the textarea.
const LARGE_PASTE_THRESHOLD = 1200

// Sentinel radio values for the special chip rows.
const AUTO_VALUE = '__auto__'
// Custom profiles are namespaced so their value never collides with a built-in
// provider id in the shared radio group.
const PROFILE_PREFIX = 'profile:'

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
  onSlashAction
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
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Slash menu is shown when the draft is exactly a "/query" with no spaces yet.
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)

  // Auto-grow the textarea up to a max height, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  // Derive whether the "/" menu should be visible and which commands match.
  const slashQuery =
    value.startsWith('/') && !value.includes(' ') && !value.includes('\n')
      ? value.slice(1).toLowerCase()
      : null
  const slashMatches = slashQuery === null ? [] : filterSlashCommands(slashQuery)

  // Keep the menu open state in sync with whether there is a "/" query + matches.
  useEffect(() => {
    const shouldOpen = slashQuery !== null && slashMatches.length > 0
    setSlashOpen(shouldOpen)
    if (shouldOpen) {
      setSlashIndex(0)
    }
  }, [slashQuery, slashMatches.length])

  const runSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.kind === 'template') {
        onChange(command.template)
      } else {
        // Action: clear the "/command" draft, then run it.
        onChange('')
        onSlashAction(command.action)
      }
      setSlashOpen(false)
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [onChange, onSlashAction]
  )

  const profileOptions = buildProfileOptions(customProviders)
  // The active option is either a custom profile or a built-in provider.
  const activeProfileOption = findProfileOption(customProviders, providerProfile)
  const providerOption = activeProfileOption ?? findProviderOption(provider)
  // Radio value: profile selection is namespaced; built-in is the raw id; Auto
  // when neither is set.
  const radioValue = providerProfile
    ? `${PROFILE_PREFIX}${providerProfile}`
    : (provider ?? AUTO_VALUE)
  const chipLabel = providerOption
    ? model
      ? `${providerOption.label} · ${model}`
      : providerOption.label
    : 'Auto'

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex flex-col gap-1 rounded-2xl border border-input bg-background px-3 py-2 shadow-sm transition-colors focus-within:border-ring">
        {/* Attachment chips above the textarea. */}
        <ChatAttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />

        <div className="relative">
          {slashOpen ? (
            <SlashCommandPopover
              matches={slashMatches}
              activeIndex={slashIndex}
              onHover={setSlashIndex}
              onPick={runSlashCommand}
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
              if (slashOpen && slashMatches.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setSlashIndex((i) => (i + 1) % slashMatches.length)
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
                  return
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault()
                  runSlashCommand(slashMatches[slashIndex])
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
              <DropdownMenuItem disabled>
                <Plug className="size-4" />
                Connectors
                <span className="ml-auto text-xs text-muted-foreground">Soon</span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Puzzle className="size-4" />
                Plugins
                <span className="ml-auto text-xs text-muted-foreground">Soon</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Provider / model chip ("Auto" by default) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {chipLabel}
                <ChevronDown className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[15rem]">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={radioValue}
                onValueChange={(next) => {
                  if (next === AUTO_VALUE) {
                    onSelectProvider({
                      provider: undefined,
                      providerProfile: undefined,
                      model: undefined
                    })
                    return
                  }
                  if (next.startsWith(PROFILE_PREFIX)) {
                    const name = next.slice(PROFILE_PREFIX.length)
                    const option = findProfileOption(customProviders, name)
                    onSelectProvider({
                      provider: undefined,
                      providerProfile: name,
                      model: option?.models?.[0]
                    })
                    return
                  }
                  const option = findProviderOption(next)
                  onSelectProvider({
                    provider: next,
                    providerProfile: undefined,
                    model: option?.models?.[0]
                  })
                }}
              >
                <DropdownMenuRadioItem value={AUTO_VALUE}>
                  Auto
                  <span className="ml-auto text-xs text-muted-foreground">default</span>
                </DropdownMenuRadioItem>
                {JCODE_PROVIDERS.map((entry) => (
                  <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </DropdownMenuRadioItem>
                ))}
                {profileOptions.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>自定义 Provider</DropdownMenuLabel>
                    {profileOptions.map((entry) => (
                      <DropdownMenuRadioItem
                        key={`${PROFILE_PREFIX}${entry.id}`}
                        value={`${PROFILE_PREFIX}${entry.id}`}
                      >
                        {entry.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </>
                ) : null}
              </DropdownMenuRadioGroup>
              {providerOption?.models && providerOption.models.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{providerOption.label} model</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={model ?? providerOption.models[0]}
                    onValueChange={(next) =>
                      // Preserve whichever of provider/profile is active when only
                      // the model changes.
                      onSelectProvider({ provider, providerProfile, model: next })
                    }
                  >
                    {providerOption.models.map((modelId) => (
                      <DropdownMenuRadioItem key={modelId} value={modelId}>
                        {modelId}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

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
              disabled={!value.trim() && attachments.length === 0}
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
