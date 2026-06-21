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
  Square
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
import type { JcodeCustomProvider } from '../../../../shared/jcode-chat-types'
import {
  JCODE_PROVIDERS,
  buildProfileOptions,
  findProfileOption,
  findProviderOption
} from './jcode-providers'

// Sentinel radio values for the special chip rows.
const AUTO_VALUE = '__auto__'
// Custom profiles are namespaced so their value never collides with a built-in
// provider id in the shared radio group.
const PROFILE_PREFIX = 'profile:'

// Why: the composer is the Claude-app-style bottom bar. It owns the unsent
// draft text (local state) and the auto-growing textarea, but the provider/model
// selection is lifted to the chat-session-store via props so it persists per
// sessionKey across tab switches. Keeping it a separate component keeps ChatPane
// focused on the message list + send wiring.

// A small, discoverable set of jcode slash commands. Selecting one inserts the
// token into the draft so the user can complete it. jcode resolves the actual
// skill; this is just an affordance.
const SLASH_COMMANDS: { command: string; hint: string }[] = [
  { command: '/init', hint: 'Summarize the project into context' },
  { command: '/review', hint: 'Review the current diff' },
  { command: '/security-review', hint: 'Audit changes for vulnerabilities' },
  { command: '/run', hint: 'Run the app to verify a change' },
  { command: '/compact', hint: 'Compact the conversation' }
]

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
  onSelectProvider
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
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  // Auto-grow the textarea up to a max height, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const insertToken = useCallback(
    (token: string) => {
      const needsSpace = value.length > 0 && !value.endsWith(' ') && !value.endsWith('\n')
      onChange(`${value}${needsSpace ? ' ' : ''}${token} `)
      // Refocus so the user can keep typing after picking from a menu.
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [value, onChange]
  )

  const onPickFiles = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (files && files.length > 0) {
        const names = Array.from(files)
          .map((file) => file.name)
          .join(' ')
        insertToken(names)
      }
      // Reset so picking the same file again re-fires change.
      event.target.value = ''
    },
    [insertToken]
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
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
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
          placeholder="Message jcode…"
          rows={1}
          className="max-h-[200px] w-full resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1.5">
          {/* Hidden native picker for "Add files". Browser-native to avoid a new
              IPC surface; we append the chosen file name(s) into the draft. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onPickFiles}
          />

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
                  window.requestAnimationFrame(() => fileInputRef.current?.click())
                }}
              >
                <Paperclip className="size-4" />
                Add files or photos
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Slash className="size-4" />
                  Slash commands
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[16rem]">
                  {SLASH_COMMANDS.map((entry) => (
                    <DropdownMenuItem
                      key={entry.command}
                      onSelect={() => insertToken(entry.command)}
                    >
                      <span className="font-medium">{entry.command}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{entry.hint}</span>
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
              disabled={!value.trim()}
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
