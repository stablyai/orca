// JA-04: the focused Orca Cloud sign-in sheet. Only Claude and Codex, each with its one action and
// status (S0's rows), so "Set up once" never lands on this computer's provider accounts.
import React from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { OrcaCloudAccountsSection } from '../OrcaCloudAccountsSection'
import {
  closeOrcaCloudSignInSheet,
  useOrcaCloudSignInSheetOpen
} from './orca-cloud-sign-in-sheet-store'

function openAllAgentAccounts(): void {
  closeOrcaCloudSignInSheet()
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'orca-cloud' })
  store.openSettingsPage()
}

/** The sheet's contents; the host owns the Sheet so fixtures can render it open. */
export function OrcaCloudSignInSheetView({
  body
}: {
  /** S0's rows; fixtures pass a fixed view. */
  body: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const titleId = React.useId()
  return (
    <SheetContent side="right" className="w-[600px] sm:max-w-[600px]" aria-labelledby={titleId}>
      <div className="border-b border-border pe-8">
        <SheetHeader>
          <SheetTitle id={titleId}>
            {t('orcaCloudSignInSheet.title', 'Agents in Orca Cloud')}
          </SheetTitle>
          <SheetDescription>
            {t(
              'orcaCloudSignInSheet.description',
              'Set up Claude and Codex once. Every cloud workspace uses them, including new, cloned and restarted ones.'
            )}
          </SheetDescription>
        </SheetHeader>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-5 py-5">{body}</div>
      <nav
        aria-label={t('orcaCloudSignInSheet.footerLabel', 'Related settings')}
        className="border-t border-border px-5 py-3 text-xs"
      >
        <button
          type="button"
          className="text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-[var(--focus-ring)]"
          onClick={openAllAgentAccounts}
        >
          {t('orcaCloudSignInSheet.allAccounts', 'All agent accounts')}
        </button>
      </nav>
    </SheetContent>
  )
}

/** Mounted once in App; opened by openOrcaCloudSignInSheet(). */
export function OrcaCloudSignInSheet(): React.JSX.Element {
  const open = useOrcaCloudSignInSheetOpen()
  return (
    <Sheet open={open} onOpenChange={(next) => !next && closeOrcaCloudSignInSheet()}>
      {open ? <OrcaCloudSignInSheetView body={<OrcaCloudAccountsSection hideHeader />} /> : null}
    </Sheet>
  )
}
