import { useEffect, useState, type JSX, type ReactNode } from 'react'
import {
  ChevronDown,
  Copy,
  MessagesSquare,
  MoreHorizontal,
  Play,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import { AI_VAULT_AGENT_LABELS } from '../../../../shared/ai-vault-types'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { AgentSessionHistoryIcon } from '@/components/right-sidebar/agent-session-history-icon'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'

// Which row's ⋯ menu is open: the native chat's (fork to CLI) or the CLI session's (move to chat).
type DemoScene = 'chat-to-cli' | 'cli-to-chat'
const SCENE_MS = 3600

type DemoRowData = {
  kind: 'chat' | 'cli'
  agent: 'claude' | 'codex'
  title: string
  text: string
  messages: number
}

function getDemoRows(): DemoRowData[] {
  return [
    {
      kind: 'chat',
      agent: 'claude',
      title: translate(
        'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.chatRowTitle',
        'Claude Chat'
      ),
      text: translate(
        'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.chatRowText',
        'Added the retry and updated the webhook tests.'
      ),
      messages: 24
    },
    {
      kind: 'cli',
      agent: 'claude',
      title: translate(
        'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.cliRowTitle',
        'Fix the flaky checkout test'
      ),
      text: translate(
        'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.cliRowText',
        'The checkout suite passed ten runs in a row.'
      ),
      messages: 12
    },
    {
      kind: 'cli',
      agent: 'codex',
      title: translate(
        'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.otherRowTitle',
        'Bump the lockfile'
      ),
      text: translate(
        'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.otherRowText',
        'Updated the dependencies; the build still passes.'
      ),
      messages: 18
    }
  ]
}

function DemoMenuItem({
  icon: Icon,
  label,
  highlighted = false
}: {
  icon?: LucideIcon
  label: string
  highlighted?: boolean
}): JSX.Element {
  return (
    <div
      data-highlighted={highlighted}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] leading-[17px] font-[450] data-[highlighted=true]:bg-foreground/[0.08] dark:data-[highlighted=true]:bg-foreground/[0.14]"
    >
      {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      <span className="truncate">{label}</span>
    </div>
  )
}

// Anchored under the row's ⋯ button, end-aligned and content-sized like the real dropdown.
function DemoMenu({
  open,
  testId,
  children,
  footer
}: {
  open: boolean
  testId: string
  children: ReactNode
  footer?: ReactNode
}): JSX.Element {
  return (
    <div
      data-open={open}
      data-testid={testId}
      className="pointer-events-none absolute inset-x-2 top-8 z-10 flex origin-top-right scale-[0.98] flex-col items-end gap-2 opacity-0 transition-[opacity,transform] duration-300 data-[open=true]:scale-100 data-[open=true]:opacity-100 motion-reduce:transition-none"
    >
      <div className="w-max max-w-full rounded-lg border border-border/70 bg-popover p-1 text-popover-foreground shadow-floating">
        {children}
      </div>
      {footer}
    </div>
  )
}

function DemoMenuSeparator(): JSX.Element {
  return <div className="my-[3px] h-px bg-border/60" />
}

function copySessionIdLabel(): string {
  return translate(
    'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.copySessionId',
    'Copy Session ID'
  )
}

function resumeLabel(): string {
  return translate(
    'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.resume',
    'Resume'
  )
}

function ChatRowMenu({ open }: { open: boolean }): JSX.Element {
  return (
    <DemoMenu
      open={open}
      testId="native-chat-upgrade-chat-menu"
      // Why: the real tooltip sits beside the item; below keeps both lines readable in a narrow panel.
      footer={
        <div className="max-w-full rounded-md bg-foreground px-3 py-1.5 text-xs text-background">
          <span className="block">
            {translate(
              'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.resumeInNewCliTooltipFork',
              'Forks this conversation into a new CLI session.'
            )}
          </span>
          <span className="block">
            {translate(
              'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.resumeInNewCliTooltipChat',
              'The native chat stays as it is.'
            )}
          </span>
        </div>
      }
    >
      <DemoMenuItem icon={Play} label={resumeLabel()} />
      <DemoMenuItem
        icon={SquareTerminal}
        highlighted
        label={translate(
          'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.resumeInNewCli',
          'Resume in New CLI'
        )}
      />
      <DemoMenuSeparator />
      <DemoMenuItem label={copySessionIdLabel()} />
    </DemoMenu>
  )
}

function CliRowMenu({ open }: { open: boolean }): JSX.Element {
  return (
    <DemoMenu open={open} testId="native-chat-upgrade-cli-menu">
      <DemoMenuItem icon={Play} label={resumeLabel()} />
      <DemoMenuItem
        icon={MessagesSquare}
        highlighted
        label={translate(
          'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.resumeInNewNativeChat',
          'Resume in New Native Chat'
        )}
      />
      <DemoMenuItem
        icon={Copy}
        label={translate(
          'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.copyResumeCommand',
          'Copy Resume Command'
        )}
      />
      <DemoMenuSeparator />
      <DemoMenuItem label={copySessionIdLabel()} />
    </DemoMenu>
  )
}

function DemoSessionRow({
  row,
  menuOpen = false,
  menu
}: {
  row: DemoRowData
  menuOpen?: boolean
  menu?: ReactNode
}): JSX.Element {
  // Why: the real row has no kind marker; the glyphs echo the menu icons so chat vs CLI reads at a glance.
  const KindIcon = row.kind === 'chat' ? MessagesSquare : SquareTerminal
  return (
    <div
      data-open={menuOpen}
      className="relative flex flex-col border-b border-sidebar-border px-3 py-2 transition-colors duration-300 data-[open=true]:bg-sidebar-accent/55 motion-reduce:transition-none"
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-5 text-foreground">
          <KindIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{row.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <span className="flex size-6 items-center justify-center rounded-md">
            <ChevronDown className="size-3.5" />
          </span>
          <span
            data-open={menuOpen}
            className="flex size-6 items-center justify-center rounded-md data-[open=true]:bg-sidebar-accent data-[open=true]:text-foreground"
          >
            <MoreHorizontal className="size-3.5" />
          </span>
        </div>
      </div>
      <div className="mt-0.5 line-clamp-1 text-[12px] leading-4 text-muted-foreground">
        <span className="font-medium text-foreground/80">
          {translate(
            'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.roleAgent',
            'Agent'
          )}
        </span>
        <span>: {row.text}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
        <AgentIcon agent={row.agent} size={14} />
        <span className="truncate">{AI_VAULT_AGENT_LABELS[row.agent]}</span>
        <span className="shrink-0 tabular-nums">
          {translate(
            'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.messageCount',
            '{{value0}} msgs',
            { value0: row.messages }
          )}
        </span>
      </div>
      {menu}
    </div>
  )
}

export function NativeChatUpgradeFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [scene, setScene] = useState<DemoScene>('chat-to-cli')
  // Why: reduced motion holds the fork scene, which carries the "chat stays" message.
  const shown: DemoScene = reducedMotion ? 'chat-to-cli' : scene
  const [chatRow, cliRow, otherRow] = getDemoRows()

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const timeoutId = window.setTimeout(
      () => setScene((current) => (current === 'chat-to-cli' ? 'cli-to-chat' : 'chat-to-cli')),
      SCENE_MS
    )
    return () => window.clearTimeout(timeoutId)
  }, [reducedMotion, scene])

  return (
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
      aria-hidden="true"
    >
      <div className="relative flex h-[19.5rem] w-full max-w-[22rem] flex-col overflow-hidden rounded-xl border border-border/80 bg-sidebar text-left shadow-xs">
        <div className="flex shrink-0 items-center gap-2 border-b border-sidebar-border px-3 py-2">
          <AgentSessionHistoryIcon size={16} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-foreground">
              {translate(
                'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.panelTitle',
                'Agent Session History'
              )}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {translate(
                'auto.components.feature.tips.NativeChatUpgradeFeatureTipVisual.panelSubtitle',
                'Resume past sessions'
              )}
            </div>
          </div>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <DemoSessionRow
            row={chatRow}
            menuOpen={shown === 'chat-to-cli'}
            menu={<ChatRowMenu open={shown === 'chat-to-cli'} />}
          />
          <DemoSessionRow
            row={cliRow}
            menuOpen={shown === 'cli-to-chat'}
            menu={<CliRowMenu open={shown === 'cli-to-chat'} />}
          />
          <DemoSessionRow row={otherRow} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sidebar to-transparent" />
      </div>
    </div>
  )
}
