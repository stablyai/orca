import React from 'react'
import { Inbox } from 'lucide-react'
import { useAppStore } from '@/store'
import { defaultScopeHost } from '@/lib/default-creation-host'
import { translate } from '@/i18n/i18n'
import { useWorkInbox } from './use-work-inbox'
import { WorkInboxSheet } from './WorkInboxSheet'

export function WorkInboxSidebarEntry(): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const settings = useAppStore((s) => s.settings)
  const activeEnvironmentId = settings ? (settings.activeRuntimeEnvironmentId ?? null) : undefined
  // Why: agents ask on the focused host; until settings load there is no host to ask.
  const target = React.useMemo(
    () =>
      activeEnvironmentId === undefined
        ? null
        : defaultScopeHost({ activeRuntimeEnvironmentId: activeEnvironmentId }),
    [activeEnvironmentId]
  )
  // Why: the hook lives here, outside the sheet, so drafts survive closing and reopening it.
  const inbox = useWorkInbox({ open, target })

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight text-worktree-sidebar-foreground/60 transition-colors hover:bg-worktree-sidebar-foreground/8"
      >
        <Inbox className="size-4 shrink-0 text-worktree-sidebar-foreground/30" strokeWidth={1.75} />
        <span className="flex-1">
          {translate('auto.components.work-inbox.sidebarLabel', 'Work Inbox')}
        </span>
      </button>
      <WorkInboxSheet open={open} onOpenChange={setOpen} inbox={inbox} />
    </>
  )
}
