import { useEffect, useState, type ComponentProps, type JSX, type ReactNode } from 'react'
import {
  ChevronRight,
  CircleCheck,
  Columns2,
  Copy,
  MessagesSquare,
  Pin,
  Plus,
  SquareTerminal,
  X
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getTabRootStateClasses
} from '@/components/tab-bar/drop-indicator'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { getChatDemoCopy } from './chat-ui-here-feature-tip-demo'

type Surface = 'terminal' | 'chat'

function DemoTab({
  active = false,
  icon,
  label
}: {
  active?: boolean
  icon: ReactNode
  label: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'relative flex h-full max-w-[10rem] items-center border-r border-border px-2 text-xs whitespace-nowrap',
        active ? 'shrink-0' : 'min-w-0 shrink',
        getTabRootStateClasses(active)
      )}
    >
      {active ? <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden /> : null}
      <span className="mr-1 flex size-3 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
      {active ? <X className="ml-1.5 size-2.5 shrink-0 opacity-60" /> : null}
    </span>
  )
}

function DemoMenuItem({
  icon,
  label,
  highlighted = false,
  chevron = false
}: {
  icon?: ReactNode
  label: string
  highlighted?: boolean
  chevron?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex h-7 items-center gap-2 rounded-sm px-2 text-sm',
        highlighted ? 'bg-accent text-accent-foreground' : 'text-foreground'
      )}
    >
      {icon ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">
          {icon}
        </span>
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
      {chevron ? <ChevronRight className="ml-auto size-3.5 text-muted-foreground" /> : null}
    </div>
  )
}

export function LiveSwitchingDemo({
  active,
  initialSurface,
  canvasClassName,
  showSkeleton = true
}: {
  active: boolean
  initialSurface?: Surface
  /** Fixture-only canvas sizing; the product dialog keeps its compact default. */
  canvasClassName?: string
  /** Fixture-only clean canvas; the product dialog shows the pane skeleton. */
  showSkeleton?: boolean
}): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [surface, setSurface] = useState<Surface>(
    () => initialSurface ?? (Math.random() < 0.5 ? 'terminal' : 'chat')
  )
  const copy = getChatDemoCopy()

  useEffect(() => {
    if (reducedMotion || !active) {
      return
    }
    const timer = window.setInterval(() => {
      setSurface((current) => (current === 'terminal' ? 'chat' : 'terminal'))
    }, 2600)
    return () => window.clearInterval(timer)
  }, [active, reducedMotion])

  const switchingToChat = surface === 'terminal'

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      <div className="relative flex h-9 items-stretch border-b border-border bg-card">
        <DemoTab
          active
          icon={switchingToChat ? <SquareTerminal /> : <MessagesSquare />}
          label={
            switchingToChat
              ? translate('featureTips.chatUiHere.liveSwitchingTerminalTab', 'Claude Code')
              : copy.tabTitle
          }
        />
        <DemoTab
          icon={<CircleCheck />}
          label={translate('featureTips.chatUiHere.liveSwitchingPolishTab', 'Polish Bottom…')}
        />
        <DemoTab
          icon={<AgentIcon agent="claude" size={12} />}
          label={translate('featureTips.chatUiHere.liveSwitchingCouncilTab', 'Council Review')}
        />
        <span className="ml-1.5 flex size-6 items-center justify-center self-center text-muted-foreground">
          <Plus className="size-3" />
        </span>
        <span className="mr-2 ml-auto flex size-6 items-center justify-center self-center text-muted-foreground">
          <Columns2 className="size-3" />
        </span>

        <div className="absolute top-full left-2 z-10 mt-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-floating">
          <DemoMenuItem
            icon={<Columns2 />}
            label={translate(
              'auto.components.tab.bar.TabWorkspaceLayoutMenuSection.moveToPaneColumn',
              'Move Tab to Split'
            )}
            chevron
          />
          <div className="my-1 h-px bg-border" />
          <DemoMenuItem
            icon={switchingToChat ? <MessagesSquare /> : <SquareTerminal />}
            label={
              switchingToChat
                ? translate(
                    'components.tab.bar.SortableTabContextMenu.switchToChatView',
                    'Continue in Chat UI'
                  )
                : translate(
                    'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
                    'Continue with Terminal Agent'
                  )
            }
            highlighted
          />
          <div className="my-1 h-px bg-border" />
          <DemoMenuItem
            icon={<Pin />}
            label={translate(
              'auto.components.tab.bar.SortableTabContextMenu.60f958ec75',
              'Pin Tab'
            )}
          />
          <DemoMenuItem
            icon={<Copy />}
            label={translate('components.tab.bar.CopyTabIdMenuItem.copy', 'Copy Tab ID')}
          />
          <div className="my-1 h-px bg-border" />
          <DemoMenuItem
            icon={<X />}
            label={translate('auto.components.tab.bar.SortableTabContextMenu.89359a36f7', 'Close')}
          />
          <DemoMenuItem
            label={translate(
              'auto.components.tab.bar.SortableTabContextMenu.8d16f9cd30',
              'Close Others'
            )}
          />
        </div>
      </div>

      <div className={cn('flex bg-muted/20', canvasClassName ?? 'h-[13rem]')}>
        {showSkeleton ? (
          <>
            <div className="w-16 shrink-0 space-y-2 border-r border-border bg-sidebar/30 p-2">
              <div className="h-1.5 w-8 rounded bg-muted-foreground/20" />
              <div className="h-1.5 w-10 rounded bg-muted-foreground/15" />
              <div className="h-1.5 w-6 rounded bg-muted-foreground/15" />
            </div>
            <div className="flex-1 space-y-2 p-3">
              <div className="h-2 w-24 rounded bg-muted-foreground/20" />
              <div className="h-1.5 w-40 rounded bg-muted-foreground/15" />
              <div className="h-1.5 w-32 rounded bg-muted-foreground/15" />
              <div className="h-1.5 w-36 rounded bg-muted-foreground/15" />
            </div>
          </>
        ) : (
          <>
            <div className="w-16 shrink-0 border-r border-border bg-sidebar/30" />
            <div className="flex-1" />
          </>
        )}
      </div>
    </div>
  )
}

/** Explains switching between Chat UI and the terminal for supported agent sessions. */
export function LiveSwitchingDemoDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  initialSurface
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus']
  initialSurface?: Surface
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>
            {translate('featureTips.chatUiHere.liveSwitchingTitle', 'Live switching 101')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'featureTips.chatUiHere.liveSwitchingDescription',
              'Right-click an agent tab to switch between Chat UI and the terminal.'
            )}
          </DialogDescription>
        </DialogHeader>

        <LiveSwitchingDemo active={open} initialSurface={initialSurface} />

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>
            {translate('featureTips.chatUiHere.liveSwitchingGotIt', 'Got it')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
