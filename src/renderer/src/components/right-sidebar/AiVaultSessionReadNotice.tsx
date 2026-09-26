import { createContext, useContext, type ReactNode } from 'react'
import { FileWarning } from 'lucide-react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  aiVaultSessionFileKey,
  NO_AI_VAULT_SESSION_READ_NOTICES,
  type AiVaultSessionReadNotices
} from './ai-vault-scan-issue-state'

const SessionReadNoticeContext = createContext<AiVaultSessionReadNotices>(
  NO_AI_VAULT_SESSION_READ_NOTICES
)

export function AiVaultSessionReadNoticeProvider({
  notices,
  children
}: {
  /**
   * Built from the browse scan in the panel. Search results come from a
   * different query, so a hit the last browse scan never saw carries no notice.
   */
  notices: AiVaultSessionReadNotices
  children: ReactNode
}): React.JSX.Element {
  return (
    <SessionReadNoticeContext.Provider value={notices}>
      {children}
    </SessionReadNoticeContext.Provider>
  )
}

function useSessionReadNotice(session: AiVaultSession): readonly string[] {
  return useContext(SessionReadNoticeContext).get(aiVaultSessionFileKey(session)) ?? []
}

function partiallyReadLabel(): string {
  return translate('sessionSearch.panel.partiallyRead', 'Partially read')
}

/**
 * Collapsed-row marker for a session whose transcript was only partly read.
 * Without it the warning would only exist behind an expand the user has no
 * reason to perform.
 */
export function SessionReadNoticeIndicator({
  session
}: {
  session: AiVaultSession
}): React.JSX.Element | null {
  const messages = useSessionReadNotice(session)
  if (messages.length === 0) {
    return null
  }
  return (
    <>
      <span className="shrink-0 text-muted-foreground/55">·</span>
      {/*
        role + tabIndex rather than a Button: the marker reports state and has no
        action, and the whole row is already one click target — a nested button
        would swallow the click that expands it. Focusable so the tooltip is
        reachable without a pointer, which is what STYLEGUIDE's trigger rule is for.
      */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="ai-vault-session-read-notice-indicator"
            role="img"
            tabIndex={0}
            className="flex shrink-0 items-center gap-1 rounded-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={partiallyReadLabel()}
          >
            <FileWarning className="size-3 text-muted-foreground" />
          </span>
        </TooltipTrigger>
        {/* Scanner-authored (sizes, byte offsets), so each sentence renders raw and whole. */}
        <TooltipContent className="max-w-64">
          <div className="flex flex-col gap-1">
            {messages.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </>
  )
}

/** The same note spelled out in the expanded row, where there is room for it. */
export function SessionReadNotice({
  session
}: {
  session: AiVaultSession
}): React.JSX.Element | null {
  const messages = useSessionReadNotice(session)
  if (messages.length === 0) {
    return null
  }
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <FileWarning className="size-3 text-muted-foreground/80" />
        <span>{partiallyReadLabel()}</span>
      </div>
      {messages.map((message) => (
        <p key={message} className="text-[11px] leading-4 text-muted-foreground">
          {message}
        </p>
      ))}
    </section>
  )
}
