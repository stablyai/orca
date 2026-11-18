import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import { WorktreeCardMetaBadges } from '../metadata/WorktreeCardMetaBadges'

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode; onSelect?: () => void }) => (
    <div>{children}</div>
  )
}))

describe('WorktreeCardDetailsHover', () => {
  it('names the bot that made the workspace', () => {
    const bot = { id: 'bot-1', hostId: 'local' as const, name: 'Ranger', avatar: null }
    const badgeMarkup = renderToStaticMarkup(
      <WorktreeCardMetaBadges
        issue={null}
        linearIssue={null}
        review={null}
        comment={null}
        bot={bot}
      />
    )
    const hoverMarkup = renderToStaticMarkup(
      <WorktreeCardDetailsHover
        issue={null}
        linearIssue={null}
        review={null}
        comment={null}
        bot={bot}
      >
        <span>worker</span>
      </WorktreeCardDetailsHover>
    )

    expect(badgeMarkup).toContain('Made by Ranger')
    expect(hoverMarkup).toContain('Made by Ranger')
  })

  it("shows a bot's workspace by its bot alone, not also as CLI-made", () => {
    const cliProvenance = { kind: 'created-by-cli' as const, createdAt: 1 }
    const botMade = renderToStaticMarkup(
      <WorktreeCardMetaBadges
        issue={null}
        linearIssue={null}
        review={null}
        comment={null}
        cliProvenance={cliProvenance}
        bot={{ id: 'bot-1', hostId: 'local', name: 'Ranger', avatar: null }}
      />
    )
    const cliMade = renderToStaticMarkup(
      <WorktreeCardMetaBadges
        issue={null}
        linearIssue={null}
        review={null}
        comment={null}
        cliProvenance={cliProvenance}
      />
    )

    expect(botMade).toContain('Made by Ranger')
    expect(botMade).not.toContain('Created by Orca CLI')
    expect(cliMade).toContain('Created by Orca CLI')
  })
})
