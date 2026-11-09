import React, { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { InlineError } from '@/components/ui/inline-error'
import { OrcaSignInButton } from '@/components/OrcaSignInProgress'
import { SettingsSegmentedControl } from '@/components/settings/form-controls/SettingsSegmentedControl'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import {
  SHARE_RESERVED_PORTS,
  type CloudShareResult,
  type ShareAudience,
  type ShareCreateRequest,
  type ShareExpiry,
  type ShareLink
} from '../../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import { SHARE_CONFIRM_ATTRIBUTE, ShareLinkRow, shareLinkState } from './share-link-row'
import { CreatedLink, PortPicker } from './share-port-dialog-parts'
import { shareErrorMessage, useShareClock } from './share-link-status'

export type SharePortDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The port to share; null asks for one. */
  port: number | null
  /** Listening ports offered as one-click choices when no port was picked. */
  detectedPorts?: readonly number[]
  /** Every link of the workspace; the form lists this port's active ones. */
  shares: ShareLink[]
  onCreate: (request: ShareCreateRequest) => Promise<CloudShareResult<{ share: ShareLink }>>
  onCopy: (url: string) => Promise<boolean>
  onOpen: (share: ShareLink) => void
  onRevoke: (share: ShareLink) => Promise<boolean>
  /** Fixtures start on the created state at a fixed time. */
  initialCreated?: { share: ShareLink; copied: boolean } | null
  fixedNow?: number
}

const NO_PORTS: readonly number[] = []

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) {
    return null
  }
  const port = Number(value)
  return port >= 1 && port <= 65535 && !SHARE_RESERVED_PORTS.includes(port) ? port : null
}

/** Mounted fresh for every open (the parent keys it), so no choice carries over. */
export function SharePortDialog({
  open,
  onOpenChange,
  port,
  detectedPorts = NO_PORTS,
  shares,
  onCreate,
  onCopy,
  onOpen,
  onRevoke,
  initialCreated = null,
  fixedNow
}: SharePortDialogProps): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const clock = useShareClock(open && fixedNow === undefined)
  const now = fixedNow ?? clock
  const [portText, setPortText] = useState(port === null ? '' : String(port))
  const [audience, setAudience] = useState<ShareAudience>('team')
  const [expiresIn, setExpiresIn] = useState<ShareExpiry>('24h')
  const [allowWake, setAllowWake] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<{ text: string; signedOut: boolean } | null>(null)
  const [created, setCreated] = useState(initialCreated)
  const submitRef = useRef<HTMLButtonElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    // Show the end of the link (its unique part), once the dialog has laid the field out.
    const frame = requestAnimationFrame(() => {
      const input = urlRef.current
      if (input) {
        input.scrollLeft = input.scrollWidth
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [created])

  const chosenPort = port ?? parsePort(portText)
  const portInvalid = port === null && portText !== '' && chosenPort === null
  const alreadyShared = shares.filter(
    (share) => share.port === chosenPort && shareLinkState(share, now) === 'active'
  )

  const submit = async (): Promise<void> => {
    if (chosenPort === null || creating) {
      return
    }
    setCreating(true)
    setError(null)
    const result = await onCreate({ port: chosenPort, audience, expiresIn, allowWake })
    setCreating(false)
    if (!openRef.current) {
      return
    }
    if (!result.ok) {
      setError({ text: shareErrorMessage(result.code), signedOut: result.code === 'unauthorized' })
      return
    }
    setCreated({ share: result.share, copied: await onCopy(result.share.url) })
  }

  const title =
    port === null
      ? t('auto.components.right.sidebar.CloudShare.titleAnyPort', 'Share a port')
      : t('auto.components.right.sidebar.CloudShare.title', 'Share port {{value0}}', {
          value0: port
        })
  const description = created
    ? created.copied
      ? t(
          'auto.components.right.sidebar.CloudShare.createdCopied',
          'Your link is ready and copied.'
        )
      : t(
          'auto.components.right.sidebar.CloudShare.createdNotCopied',
          'Your link is ready. Copy it below.'
        )
    : port === null
      ? t(
          'auto.components.right.sidebar.CloudShare.descriptionAnyPort',
          'Get a link that opens a port in a browser.'
        )
      : t(
          'auto.components.right.sidebar.CloudShare.description',
          'Get a link that opens port {{value0}} in a browser.',
          { value0: port }
        )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A create in flight finishes here, so its link and clipboard write aren't orphaned.
        if (!next && creating) {
          return
        }
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(`[${SHARE_CONFIRM_ATTRIBUTE}]`)
          ) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription role="status">{description}</DialogDescription>
        </DialogHeader>

        {created ? (
          <CreatedLink
            created={created.share}
            copied={created.copied}
            now={now}
            urlRef={urlRef}
            onCopy={onCopy}
          />
        ) : (
          <form
            id={formId}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            {port === null && (
              <PortPicker
                id={`${formId}-port`}
                value={portText}
                invalid={portInvalid}
                chosenPort={chosenPort}
                detectedPorts={detectedPorts}
                onChange={setPortText}
              />
            )}
            <div className="space-y-2">
              <p id={`${formId}-audience`} className="text-xs text-muted-foreground">
                {t('auto.components.right.sidebar.CloudShare.audienceLabel', 'Who can open it')}
              </p>
              <SettingsSegmentedControl
                size="sm"
                value={audience}
                onChange={setAudience}
                ariaLabelledBy={`${formId}-audience`}
                ariaDescribedBy={`${formId}-audience-hint`}
                options={[
                  {
                    value: 'team',
                    label: t('auto.components.right.sidebar.CloudShare.audienceTeam', 'Team only')
                  },
                  {
                    value: 'public',
                    label: t(
                      'auto.components.right.sidebar.CloudShare.audiencePublicShort',
                      'Public'
                    )
                  }
                ]}
              />
              <p id={`${formId}-audience-hint`} className="text-xs text-muted-foreground">
                {audience === 'team'
                  ? t(
                      'auto.components.right.sidebar.CloudShare.audienceTeamHint',
                      'Teammates open it from Orca, signed in to your team.'
                    )
                  : t(
                      'auto.components.right.sidebar.CloudShare.audiencePublicHint',
                      'Anyone who has the link can open it without signing in.'
                    )}
              </p>
            </div>
            <div className="space-y-2">
              <p id={`${formId}-expiry`} className="text-xs text-muted-foreground">
                {t('auto.components.right.sidebar.CloudShare.expiryLabel', 'Expires')}
              </p>
              <SettingsSegmentedControl
                size="sm"
                value={expiresIn}
                onChange={setExpiresIn}
                ariaLabelledBy={`${formId}-expiry`}
                options={[
                  {
                    value: '1h',
                    label: t('auto.components.right.sidebar.CloudShare.expiry1h', 'In 1 hour')
                  },
                  {
                    value: '24h',
                    label: t('auto.components.right.sidebar.CloudShare.expiry24h', 'In 24 hours')
                  },
                  {
                    value: '7d',
                    label: t('auto.components.right.sidebar.CloudShare.expiry7d', 'In 7 days')
                  }
                ]}
              />
            </div>
            <div className="flex items-start justify-between gap-4">
              <span className="space-y-0.5">
                <span id={`${formId}-wake`} className="block text-sm">
                  {t(
                    'auto.components.right.sidebar.CloudShare.wakeLabel',
                    'Let visitors wake the workspace'
                  )}
                </span>
                <span id={`${formId}-wake-hint`} className="block text-xs text-muted-foreground">
                  {t(
                    'auto.components.right.sidebar.CloudShare.wakeHint',
                    'Otherwise the link works only while the workspace is awake. Wake time counts toward your usage.'
                  )}
                </span>
              </span>
              <Switch
                checked={allowWake}
                onCheckedChange={setAllowWake}
                className="mt-0.5"
                aria-labelledby={`${formId}-wake`}
                aria-describedby={`${formId}-wake-hint`}
              />
            </div>
            {error && (
              <InlineError
                title={t(
                  'auto.components.right.sidebar.CloudShare.createFailed',
                  'Couldn’t create the link.'
                )}
                detail={error.text}
              />
            )}
            {error?.signedOut && (
              <OrcaSignInButton variant="outline" size="xs">
                {t('auto.components.right.sidebar.CloudShare.signIn', 'Sign in to Orca')}
              </OrcaSignInButton>
            )}
            {alreadyShared.length > 0 && (
              <div className="space-y-1">
                <p className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('auto.components.right.sidebar.CloudShare.alreadyShared', 'Already shared')}
                </p>
                <div>
                  {alreadyShared.map((share) => (
                    <ShareLinkRow
                      key={share.id}
                      share={share}
                      now={now}
                      showPort={false}
                      alwaysShowActions
                      onCopy={onCopy}
                      onOpen={onOpen}
                      onRevoke={onRevoke}
                      onRevoked={() => submitRef.current?.focus()}
                    />
                  ))}
                </div>
              </div>
            )}
          </form>
        )}

        <DialogFooter>
          {created ? (
            <Button type="button" autoFocus onClick={() => onOpenChange(false)}>
              {t('auto.components.right.sidebar.CloudShare.done', 'Done')}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={creating}
                onClick={() => onOpenChange(false)}
              >
                {t('auto.components.right.sidebar.CloudShare.cancel', 'Cancel')}
              </Button>
              <Button
                ref={submitRef}
                type="submit"
                form={formId}
                disabled={chosenPort === null || creating}
              >
                {creating && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}
                {audience === 'public'
                  ? t('auto.components.right.sidebar.CloudShare.createPublic', 'Create public link')
                  : t('auto.components.right.sidebar.CloudShare.create', 'Create link')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
