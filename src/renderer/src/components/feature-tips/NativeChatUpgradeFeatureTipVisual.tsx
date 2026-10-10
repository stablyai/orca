import { useEffect, useState, type JSX, type ReactNode } from 'react'
import {
  Copy,
  LocateFixed,
  MessagesSquare,
  MoreHorizontal,
  Play,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { aiVaultSessionResumeLabel } from '@/components/right-sidebar/ai-vault-session-resume'
import { translate } from '@/i18n/i18n'
import { DemoSessionPanel, DemoSessionRow } from './feature-tip-session-panel-demo'
import { getSessionSearchDemoRecentRows } from './session-search-feature-tip-demo'

const SCENE_MS = 3600

type DemoMenuItem = { icon: LucideIcon; label: string; highlighted?: boolean }

// Scene 0 is a Claude native chat (row 0); scene 1 a Codex CLI session (row 1).
function getSceneMenus(): DemoMenuItem[][] {
  const copyResume = {
    icon: Copy,
    label: translate(
      'auto.components.right.sidebar.AiVaultSessionRow.copyResumeCommand',
      'Copy Resume Command'
    )
  }
  return [
    [
      {
        icon: LocateFixed,
        label: translate(
          'auto.components.right.sidebar.AiVaultSessionRow.jumpToOriginalPane',
          'Jump to Original Pane'
        )
      },
      {
        icon: SquareTerminal,
        label: translate(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCli',
          'Resume in New CLI'
        ),
        highlighted: true
      },
      copyResume
    ],
    [
      { icon: Play, label: aiVaultSessionResumeLabel({ usesSessionWorktree: false }) },
      {
        icon: MessagesSquare,
        label: translate(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
          'Resume in New Native Chat'
        ),
        highlighted: true
      },
      copyResume
    ]
  ]
}

/** A still copy of the row's ⋯ menu, lifted off the dark sidebar so the action reads at a glance. */
function DemoActionMenu({
  items,
  opensUp
}: {
  items: DemoMenuItem[]
  opensUp: boolean
}): JSX.Element {
  return (
    <>
      <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md bg-sidebar-accent text-foreground">
        <MoreHorizontal className="size-3.5" />
      </span>
      {/* Why: the second row sits low in the panel, so its menu flips above like the real one. */}
      <div
        data-opens-up={opensUp}
        className="absolute right-2 top-9 z-10 min-w-[12.5rem] rounded-[11px] border border-foreground/20 bg-popover p-1 text-popover-foreground shadow-floating animate-in fade-in-0 zoom-in-[0.98] duration-150 data-[opens-up=true]:top-auto data-[opens-up=true]:bottom-[calc(100%-0.25rem)] motion-reduce:animate-none dark:border-foreground/25 dark:bg-[color-mix(in_srgb,var(--foreground)_10%,var(--popover))]"
      >
        {items.map(({ icon: Icon, label, highlighted = false }) => (
          <div
            key={label}
            data-highlighted={highlighted}
            className="flex items-center gap-2 whitespace-nowrap rounded-md px-2 py-[4px] text-[12px] font-[450] leading-[17px] text-muted-foreground data-[highlighted=true]:bg-[color-mix(in_srgb,var(--foreground)_10%,var(--popover))] data-[highlighted=true]:font-medium data-[highlighted=true]:text-foreground data-[highlighted=true]:ring-1 data-[highlighted=true]:ring-inset data-[highlighted=true]:ring-foreground/25 dark:data-[highlighted=true]:bg-[color-mix(in_srgb,var(--foreground)_22%,var(--popover))] dark:data-[highlighted=true]:ring-foreground/35"
          >
            <Icon className="size-3.5 shrink-0" />
            {label}
          </div>
        ))}
      </div>
    </>
  )
}

export function NativeChatUpgradeFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [scene, setScene] = useState(0)
  const menus = getSceneMenus()
  // Why: reduced motion holds the first menu instead of alternating.
  const shownScene = reducedMotion ? 0 : scene

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const timeoutId = window.setTimeout(() => setScene((current) => (current + 1) % 2), SCENE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [reducedMotion, scene])

  return (
    <DemoSessionPanel>
      {/* Dimming the other rows keeps the eye on the open menu. Not clipped, so an upward menu
          can overlap the header like the real one; the panel still clips the rows. */}
      <div className="min-h-0 flex-1 [&>[data-focused=false]]:opacity-55">
        {getSessionSearchDemoRecentRows().map((row, index) => {
          const focused = index === shownScene
          let menu: ReactNode = null
          if (focused) {
            menu = <DemoActionMenu items={menus[shownScene]} opensUp={index > 0} />
          }
          return (
            <DemoSessionRow key={row.title} row={row} isHit={false} focused={focused} index={index}>
              {menu}
            </DemoSessionRow>
          )
        })}
      </div>
    </DemoSessionPanel>
  )
}
