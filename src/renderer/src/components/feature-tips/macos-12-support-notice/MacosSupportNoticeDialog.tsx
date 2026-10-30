import { useRef, type JSX, type MouseEvent } from 'react'
import { ArrowUpRight, ChevronDown } from 'lucide-react'
import type { MacosUpgradeSupport } from '../../../../../shared/macos-12-support-notice/upgrade-support'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

export const MACOS_UPDATE_GUIDE_URL = 'https://support.apple.com/en-us/108382'
export const MACOS_COMPATIBILITY_URL = 'https://support.apple.com/en-us/102861'
export const OMARCHY_MAC_GUIDE_URL = 'https://omarchy.org/manual/mac-support/'

export function MacosSupportNoticeDialog({
  open,
  onOpenChange,
  support,
  onOpenUrl
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  support: MacosUpgradeSupport | null | undefined
  onOpenUrl: (url: string, event: MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const checking = support === undefined
  const canUpgrade = support?.macos13 === 'supported'
  const cannotUpgrade = support?.macos13 === 'unsupported'
  const primaryUrl = canUpgrade
    ? MACOS_UPDATE_GUIDE_URL
    : cannotUpgrade
      ? OMARCHY_MAC_GUIDE_URL
      : MACOS_COMPATIBILITY_URL

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        scrollable
        onOpenAutoFocus={(event) => {
          if (!checking) {
            event.preventDefault()
            primaryButtonRef.current?.focus({ preventScroll: true })
          }
        }}
      >
        <DialogHeader>
          <DialogTitle size="display">
            {translate('macosSupport.title', 'A heads-up for your Mac')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'macosSupport.description',
              'A future version of Orca will require macOS 13 or later.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2" aria-live="polite" aria-busy={checking}>
          <p className="text-sm leading-relaxed">
            {checking
              ? translate('macosSupport.checking', 'Checking whether this Mac can upgrade…')
              : canUpgrade
                ? translate(
                    'macosSupport.upgradeDescription',
                    'Your Mac can upgrade. Update macOS to keep receiving Orca updates.'
                  )
                : cannotUpgrade
                  ? translate(
                      'macosSupport.omarchyDescription',
                      'Apple doesn’t support macOS 13 on this Mac. Orca also runs on Omarchy, a Linux desktop.'
                    )
                  : translate(
                      'macosSupport.unknownDescription',
                      'We couldn’t confirm an upgrade for this Mac. Apple’s compatibility guide can help.'
                    )}
          </p>
          {cannotUpgrade ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'macosSupport.omarchyBackup',
                'Installing Omarchy replaces macOS. Back up your files first.'
              )}
            </p>
          ) : null}
        </div>

        <Collapsible>
          <CollapsibleTrigger variant="row">
            {translate('macosSupport.whyTitle', 'Why is this changing?')}
            <ChevronDown
              className="size-4 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 pt-2 text-sm leading-relaxed">
              <p>
                {translate(
                  'macosSupport.whyIntro',
                  'We’re updating Electron, the foundation Orca runs on, to bring:'
                )}
              </p>
              <ul className="list-disc space-y-2 pl-4">
                <li>
                  {translate(
                    'macosSupport.whySecurity',
                    'Ongoing security fixes from Electron and Chromium.'
                  )}
                </li>
                <li>
                  {translate(
                    'macosSupport.whyPerformance',
                    'Faster startup and more efficient native API calls.'
                  )}
                </li>
                <li>
                  {translate(
                    'macosSupport.whySystemApis',
                    'Support for current macOS notification APIs and secure Keychain storage.'
                  )}
                </li>
              </ul>
              <p>
                {translate(
                  'macosSupport.whyRequirement',
                  'That newer foundation requires macOS 13 or later.'
                )}
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <p className="text-xs text-muted-foreground">
          {translate('macosSupport.stillWorks', 'This Orca version will keep working for now.')}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {translate('macosSupport.dismiss', 'Got it')}
          </Button>
          <Button
            ref={primaryButtonRef}
            disabled={checking}
            onClick={(event) => onOpenUrl(primaryUrl, event)}
          >
            {checking
              ? translate('macosSupport.checkingAction', 'Checking your Mac…')
              : canUpgrade
                ? translate('macosSupport.updateAction', 'How to update macOS')
                : cannotUpgrade
                  ? translate('macosSupport.omarchyAction', 'Explore Omarchy')
                  : translate('macosSupport.checkAction', 'Check compatibility')}
            {!checking ? <ArrowUpRight className="size-4" aria-hidden /> : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
