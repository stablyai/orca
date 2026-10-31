import { useMemo, type CSSProperties, type JSX, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, Eye, Hand, Plus, X } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { FlowDiagram } from '@/components/feature-tips/ChatUiHereFeatureTipVisual'
import {
  CHAT_DEMO_FILE,
  CHAT_DEMO_MODEL,
  getChatDemoCopy
} from '@/components/feature-tips/chat-ui-here-feature-tip-demo'
import { nativeChatPermissionModeLabel } from '@/components/native-chat/native-chat-permission-mode-labels'
import { nativeChatToolRowVerb } from '@/components/native-chat/native-chat-tool-line-label'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getTabRootStateClasses
} from '@/components/tab-bar/drop-indicator'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { buildFontFamily } from '@/lib/monospace-font-family'
import { resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'

// The tip's chat miniature, finished and denser so it fits a tile; nothing here animates.
const CHAT_SCALE: CSSProperties & { '--chat-font-size': string } = { '--chat-font-size': '10px' }

/** One tab in the real tab bar's active style, then its "+" button. */
function MiniWindow({
  title,
  className,
  children
}: {
  title: string
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-lg border border-border text-left shadow-xs',
        className
      )}
    >
      <div className="flex h-7 shrink-0 items-stretch border-b border-border bg-card">
        <span
          className={cn(
            'relative flex max-w-[150px] min-w-0 shrink-0 items-center border-r border-border pr-1.5 pl-3 text-[10.5px]',
            getTabRootStateClasses(true)
          )}
        >
          <span className="mr-1.5 flex shrink-0">
            <AgentIcon agent="claude" size={12} />
          </span>
          <span className="mr-1.5 min-w-0 truncate">{title}</span>
          <X className="size-2.5 shrink-0 text-muted-foreground" />
          <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden />
        </span>
        <span className="ml-1.5 flex size-6 items-center justify-center self-center text-muted-foreground">
          <Plus className="size-3" />
        </span>
      </div>
      {children}
    </div>
  )
}

export function ChatSurfacePreview(): JSX.Element {
  const copy = getChatDemoCopy()
  return (
    <MiniWindow title={copy.tabTitle} className="bg-chat-canvas">
      <div
        className="native-chat-appearance flex min-h-0 flex-1 flex-col text-[10px] leading-[14px] text-chat-foreground-strong"
        style={CHAT_SCALE}
      >
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-[7px] overflow-hidden px-3 pt-2">
          <div className="flex justify-end">
            <span className="max-w-[80%] truncate rounded-[10px] border border-chat-user-border bg-chat-user-surface px-[9px] py-1">
              {copy.prompt}
            </span>
          </div>
          <div className="flex items-center gap-[5px] whitespace-nowrap text-chat-foreground-faint">
            <Eye className="size-[11px] shrink-0" />
            {nativeChatToolRowVerb('read')}
            <span className="text-chat-foreground-strong">{CHAT_DEMO_FILE}</span>
          </div>
          <p className="line-clamp-4">
            {copy.reply.map((token, index) => (
              <span
                key={index}
                className={cn(token.link && 'underline decoration-current/40 underline-offset-2')}
              >
                {token.text}
              </span>
            ))}
          </p>
          <div className="-my-2.5 shrink-0">
            <FlowDiagram
              flow={copy.flow}
              frame={{ nodes: copy.flow.length, arrows: copy.flow.length - 1 }}
            />
          </div>
        </div>
        <div className="shrink-0 px-3 pt-2 pb-3">
          <div className="rounded-[10px] border border-chat-composer-border bg-chat-composer-surface px-1.5 pt-1.5 pb-[5px] shadow-xs">
            <div className="truncate px-1 pb-1.5 text-[9.5px] leading-[13px] text-chat-foreground-faint">
              {translate(
                'components.native-chat.composer.placeholder',
                'Ask anything, @ to mention files, / for commands'
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1 text-[9px] whitespace-nowrap text-chat-foreground-faint">
              <Plus className="size-[11px] shrink-0" />
              <span className="flex min-w-0 items-center gap-[3px] px-[3px]">
                <Hand className="size-[9px] shrink-0" />
                <span className="truncate">{nativeChatPermissionModeLabel('ask')}</span>
                <ChevronDown className="size-[9px] shrink-0" />
              </span>
              <span className="flex-1" />
              <span className="flex shrink-0 items-center gap-[3px] px-[3px]">
                {CHAT_DEMO_MODEL}
                <ChevronDown className="size-[9px]" />
              </span>
              <span className="flex size-[17px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-50">
                <ArrowUp className="size-2.5" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </MiniWindow>
  )
}

// Claude Code's pixel mascot, drawn in its own orange like the CLI does.
const MASCOT = ['.XXXXXXX.', '.X.XXX.X.', 'XXXXXXXXX', '.XXXXXXX.', '.X.X.X.X.']

function Mascot(): JSX.Element {
  return (
    <svg
      viewBox="0 0 9 5"
      width={27}
      height={15}
      shapeRendering="crispEdges"
      className="shrink-0 fill-[#d97757]"
    >
      {MASCOT.flatMap((row, y) =>
        Array.from(row).map((cell, x) =>
          cell === 'X' ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null
        )
      )}
    </svg>
  )
}

/** Claude Code's own interface, in the user's terminal theme and font. */
export function TerminalSurfacePreview({ settings }: { settings: GlobalSettings }): JSX.Element {
  const copy = getChatDemoCopy()
  const systemPrefersDark = useSystemPrefersDark()
  const customThemes = JSON.stringify(settings.terminalCustomThemes)
  const pluginPalettes = JSON.stringify(settings.terminalPluginPalettes)
  const colorOverrides = JSON.stringify(settings.terminalColorOverrides)
  const theme = useMemo(
    () =>
      composeActiveTerminalTheme(
        resolveEffectiveTerminalAppearance(settings, systemPrefersDark).theme,
        settings
      ),
    // Settings IPC returns fresh collections even when appearance values are unchanged.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      settings.theme,
      settings.terminalThemeDark,
      settings.terminalThemeLight,
      settings.terminalUseSeparateLightTheme,
      settings.terminalDividerColorDark,
      settings.terminalDividerColorLight,
      customThemes,
      pluginPalettes,
      colorOverrides,
      settings.terminalBackgroundOpacity,
      settings.terminalCursorOpacity,
      systemPrefersDark
    ]
  )
  const foreground = theme?.foreground ?? '#e6e6e6'
  const dim = { color: theme?.brightBlack ?? '#8b9099' }
  const reply = copy.reply.map((token) => token.text).join('')
  return (
    <MiniWindow title="Claude">
      <div
        className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 pt-2.5 pb-3 text-[10px] leading-[15px] whitespace-nowrap"
        style={{
          background: theme?.background ?? '#23262b',
          color: foreground,
          fontFamily: buildFontFamily(settings.terminalFontFamily)
        }}
      >
        <div className="flex items-center gap-2.5">
          <Mascot />
          <div className="min-w-0">
            <div className="truncate font-bold">Claude Code</div>
            <div className="truncate" style={dim}>
              {CHAT_DEMO_MODEL} · ~/projects/acme-web
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="truncate" style={dim}>
            &gt; {copy.prompt}
          </div>
          <div className="flex items-baseline truncate">
            <TerminalDot color={theme?.green ?? '#4eba65'} />
            <b>Read</b>(src/{CHAT_DEMO_FILE})
          </div>
          <div className="truncate pl-[2ch]" style={dim}>
            ⎿ Read 84 lines
          </div>
          <div className="flex items-baseline">
            <TerminalDot color={foreground} />
            <span className="line-clamp-3 min-w-0 whitespace-normal">{reply}</span>
          </div>
        </div>
        <div
          className="flex h-[22px] shrink-0 items-center gap-[1ch] border-y"
          style={{ borderColor: `color-mix(in srgb, ${foreground} 30%, transparent)` }}
        >
          ❯<span className="inline-block h-3 w-1.5" style={{ background: foreground }} />
        </div>
      </div>
    </MiniWindow>
  )
}

// The CLI's ⏺ falls back to an emoji on some systems, so the dot is drawn, one cell wide.
function TerminalDot({ color }: { color: string }): JSX.Element {
  return (
    <span
      className="mr-[calc(1ch-1px)] ml-px inline-block size-1.5 shrink-0 self-center rounded-full"
      style={{ background: color }}
    />
  )
}
