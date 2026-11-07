import { useRef, type JSX, type MouseEvent } from 'react'
import { ArrowUpRight, ChevronDown } from 'lucide-react'
import {
  isVenturaRequirement,
  type MacosUpgradeSupport
} from '../../../../shared/macos-upgrade-support'
import type { UnsupportedSystemUpdate } from '../../../../shared/update-status-types'
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

const MACOS_UPDATE_GUIDE_URL = 'https://support.apple.com/en-us/108382'
const VENTURA_COMPATIBILITY_URL = 'https://support.apple.com/en-us/102861'
const MACOS_SUPPORT_DISCUSSION_URL = 'https://github.com/stablyai/orca/discussions/38765'

export function MacosUpdateRequirementDialog({
  open,
  onOpenChange,
  requirement,
  support,
  onOpenUrl
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  requirement: UnsupportedSystemUpdate
  /** Undefined while the local probe runs. */
  support: MacosUpgradeSupport | undefined
  onOpenUrl: (url: string, event: MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const macos = requirement.minimumMacosVersion
  const checking = support === undefined
  const canUpgrade = support === 'supported'
  const cannotUpgrade = support === 'unsupported'
  const primaryUrl = canUpgrade
    ? MACOS_UPDATE_GUIDE_URL
    : cannotUpgrade
      ? MACOS_SUPPORT_DISCUSSION_URL
      : isVenturaRequirement(macos)
        ? VENTURA_COMPATIBILITY_URL
        : MACOS_UPDATE_GUIDE_URL

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
          <DialogTitle size="display" className="mr-6">
            {translate('macosUpdateRequirement.title', 'Orca updates now need macOS {{macos}}', {
              macos
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'macosUpdateRequirement.description',
              'Orca {{version}} requires macOS {{macos}} or later. This version keeps working, but it won’t get new updates on this Mac.',
              { version: requirement.version, macos }
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2" aria-live="polite" aria-busy={checking}>
          <p className="text-sm leading-relaxed">
            {checking
              ? translate(
                  'macosUpdateRequirement.checking',
                  'Checking whether this Mac can upgrade…'
                )
              : canUpgrade
                ? translate(
                    'macosUpdateRequirement.upgradeDescription',
                    'Your Mac can upgrade. Update macOS to get the latest Orca.'
                  )
                : cannotUpgrade
                  ? translate(
                      'macosUpdateRequirement.unsupportedDescription',
                      'Apple doesn’t support macOS {{macos}} on this Mac.',
                      { macos }
                    )
                  : translate(
                      'macosUpdateRequirement.unknownDescription',
                      'We couldn’t confirm an upgrade for this Mac. Apple’s compatibility guide can help.'
                    )}
          </p>
        </div>

        <Collapsible>
          <CollapsibleTrigger variant="row">
            {translate('macosUpdateRequirement.whyTitle', 'Why is this changing?')}
            <ChevronDown
              className="size-4 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 pt-2 text-sm leading-relaxed">
              <p>
                {translate(
                  'macosUpdateRequirement.whyIntro',
                  'We updated parts of Orca’s foundation, like Electron and the on-device speech engine, to bring:'
                )}
              </p>
              <ul className="list-disc space-y-2 pl-4">
                <li>
                  {translate(
                    'macosUpdateRequirement.whySecurity',
                    'Ongoing security fixes from Electron and Chromium.'
                  )}
                </li>
                <li>
                  {translate(
                    'macosUpdateRequirement.whyPerformance',
                    'Faster startup and more efficient native API calls.'
                  )}
                </li>
                <li>
                  {translate(
                    'macosUpdateRequirement.whySystemApis',
                    'Support for current macOS notification APIs and secure Keychain storage.'
                  )}
                </li>
              </ul>
              <p>
                {translate(
                  'macosUpdateRequirement.whyRequirement',
                  'That newer foundation requires macOS {{macos}} or later.',
                  { macos }
                )}
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {translate('macosUpdateRequirement.dismiss', 'Got it')}
          </Button>
          <Button
            ref={primaryButtonRef}
            disabled={checking}
            onClick={(event) => onOpenUrl(primaryUrl, event)}
          >
            {checking
              ? translate('macosUpdateRequirement.checkingAction', 'Checking your Mac…')
              : canUpgrade
                ? translate('macosUpdateRequirement.updateAction', 'How to update macOS')
                : cannotUpgrade
                  ? translate('macosUpdateRequirement.discussionAction', 'Join the discussion')
                  : translate('macosUpdateRequirement.checkAction', 'Check compatibility')}
            {!checking ? <ArrowUpRight className="size-4" aria-hidden /> : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
