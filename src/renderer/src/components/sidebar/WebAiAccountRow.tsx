import React from 'react'
import { AlertTriangle, Globe2, MoreHorizontal, Plus, Settings2, Trash2, Waves } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserSessionProfile, WebAiAccount, WebAiProvider } from '../../../../shared/types'
import { getWebAiAccountServiceLabel } from '../../../../shared/web-ai-accounts'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ClaudeIcon, GeminiIcon, OpenAIIcon } from '@/components/status-bar/icons'

function WebAiProviderIcon({ provider }: { provider: WebAiProvider }): React.JSX.Element {
  if (provider === 'chatgpt') {
    return <OpenAIIcon size={15} />
  }
  if (provider === 'claude') {
    return <ClaudeIcon size={15} />
  }
  if (provider === 'gemini' || provider === 'aistudio') {
    return <GeminiIcon size={15} />
  }
  if (provider === 'custom') {
    return <Globe2 className="size-[15px]" strokeWidth={2} />
  }
  return <Waves className="size-[15px]" strokeWidth={2} />
}

type WebAiAccountRowProps = {
  account: WebAiAccount
  profile: BrowserSessionProfile | null
  profilesLoaded: boolean
  tabCount: number
  active: boolean
  onLaunch: (account: WebAiAccount, openNewTab?: boolean) => void
  onManageProfiles: () => void
  onRemove: (account: WebAiAccount) => void
}

const WebAiAccountRow = React.memo(function WebAiAccountRow({
  account,
  profile,
  profilesLoaded,
  tabCount,
  active,
  onLaunch,
  onManageProfiles,
  onRemove
}: WebAiAccountRowProps): React.JSX.Element {
  useTranslation()
  const serviceLabel = getWebAiAccountServiceLabel(account)
  const profileMissing =
    profilesLoaded &&
    (!profile || profile.scope === 'default' || profile.partition !== account.sessionPartition)

  return (
    <div className="group flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        onClick={() => onLaunch(account)}
        aria-label={account.label}
        aria-describedby={profileMissing ? `web-ai-profile-status-${account.id}` : undefined}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left transition-colors',
          active
            ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
            : 'text-worktree-sidebar-foreground/65 hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground/85'
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <WebAiProviderIcon provider={account.provider} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium leading-4">{account.label}</span>
          <span className="block truncate text-[10px] leading-3 text-worktree-sidebar-foreground/40">
            {serviceLabel} / {profile?.label ?? account.profileId}
          </span>
        </span>
        {profileMissing ? (
          <>
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <span id={`web-ai-profile-status-${account.id}`} className="sr-only">
              {translate(
                'auto.components.sidebar.WebAiAccountsSection.profileMissing',
                'This browser profile no longer exists.'
              )}
            </span>
          </>
        ) : tabCount > 0 ? (
          <span className="min-w-4 shrink-0 text-center text-[10px] tabular-nums text-worktree-sidebar-foreground/35">
            {tabCount}
          </span>
        ) : null}
      </button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-worktree-sidebar-foreground/35 opacity-60 hover:text-worktree-sidebar-foreground group-hover:opacity-100"
            aria-label={translate(
              'auto.components.sidebar.WebAiAccountsSection.openNewTabForAccount',
              'Open another browser tab for {{value0}}',
              { value0: account.label }
            )}
            disabled={profileMissing}
            onClick={() => onLaunch(account, true)}
          >
            <Plus className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {translate(
            'auto.components.sidebar.WebAiAccountsSection.openNewTab',
            'Open another browser tab'
          )}
        </TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-worktree-sidebar-foreground/35 opacity-0 hover:text-worktree-sidebar-foreground focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={translate(
              'auto.components.sidebar.WebAiAccountsSection.moreActionsForAccount',
              'More actions for {{value0}}',
              { value0: account.label }
            )}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={profileMissing} onSelect={() => onLaunch(account, true)}>
            <Plus />
            {translate(
              'auto.components.sidebar.WebAiAccountsSection.openNewTab',
              'Open another browser tab'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onManageProfiles}>
            <Settings2 />
            {translate(
              'auto.components.sidebar.WebAiAccountsSection.manageProfile',
              'Manage browser profile'
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onRemove(account)}>
            <Trash2 />
            {translate(
              'auto.components.sidebar.WebAiAccountsSection.remove',
              'Remove from sidebar'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

export default WebAiAccountRow
