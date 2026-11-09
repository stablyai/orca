import React from 'react'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import {
  SHARE_RESERVED_PORTS,
  type ShareLink
} from '../../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import { CopyShareLinkButton, ShareAudienceIcon } from './share-link-row'
import { formatShareTimeLeft } from './share-link-status'

/** Port field for "Share a port", with the listening ports as one-click choices. */
export function PortPicker({
  id,
  value,
  invalid,
  chosenPort,
  detectedPorts,
  onChange
}: {
  id: string
  value: string
  invalid: boolean
  chosenPort: number | null
  detectedPorts: readonly number[]
  onChange: (value: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs text-muted-foreground">
        {t('auto.components.right.sidebar.CloudShare.portLabel', 'Port')}
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          id={id}
          inputMode="numeric"
          autoFocus
          placeholder="8080"
          value={value}
          aria-invalid={invalid}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.value.trim())}
          variant="code"
          className="h-8 w-24"
        />
        {detectedPorts.length > 0 && (
          <RadioGroup
            layout="inline"
            value={chosenPort === null ? '' : String(chosenPort)}
            onValueChange={onChange}
            aria-label={t(
              'auto.components.right.sidebar.CloudShare.listeningPorts',
              'Listening ports'
            )}
          >
            {detectedPorts
              .filter((detected) => !SHARE_RESERVED_PORTS.includes(detected))
              .slice(0, 5)
              .map((detected) => (
                <RadioGroupItem key={detected} variant="pill" value={String(detected)}>
                  {detected}
                </RadioGroupItem>
              ))}
          </RadioGroup>
        )}
      </div>
      <p
        id={`${id}-hint`}
        className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
      >
        {invalid
          ? t(
              'auto.components.right.sidebar.CloudShare.portInvalid',
              'Enter a port from 1 to 65535. Ports 2222, 6768 and 6769 are used by Orca.'
            )
          : detectedPorts.length > 0
            ? t(
                'auto.components.right.sidebar.CloudShare.portHintDetected',
                'Or pick a port that’s listening.'
              )
            : t(
                'auto.components.right.sidebar.CloudShare.portHint',
                'The port your dev server listens on.'
              )}
      </p>
    </div>
  )
}

export function CreatedLink({
  created,
  copied,
  now,
  urlRef,
  onCopy
}: {
  created: ShareLink
  /** The create already copied it: the Copy button starts on "Copied". */
  copied: boolean
  now: number
  urlRef: React.RefObject<HTMLInputElement | null>
  onCopy: (url: string) => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const audienceLabel =
    created.audience === 'public'
      ? t('auto.components.right.sidebar.CloudShare.audiencePublicShort', 'Public')
      : t('auto.components.right.sidebar.CloudShare.audienceTeam', 'Team only')
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Input
          ref={urlRef}
          readOnly
          value={created.url}
          aria-label={t('auto.components.right.sidebar.CloudShare.linkLabel', 'Share link')}
          variant="code"
          className="h-8"
          onFocus={(event) => event.currentTarget.select()}
        />
        <CopyShareLinkButton
          url={created.url}
          onCopy={onCopy}
          withLabel
          initialCopied={copied}
          className="h-8"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <ShareAudienceIcon audience={created.audience} />
        <span className={created.audience === 'public' ? 'text-foreground' : undefined}>
          {audienceLabel}
        </span>
        <span aria-hidden>·</span>
        <span>
          {t('auto.components.right.sidebar.CloudShare.timeLeft', '{{value0}} left', {
            value0: formatShareTimeLeft(created.expiresAt, now)
          })}
        </span>
        {created.allowWake && (
          <>
            <span aria-hidden>·</span>
            <span>{t('auto.components.right.sidebar.CloudShare.canWake', 'Can wake')}</span>
          </>
        )}
      </div>
      {created.audience === 'public' ? (
        // Warning tint: this link works for anyone it reaches, signed in or not.
        <p className="rounded-md border border-status-warning-border bg-status-warning-background px-2.5 py-2 text-xs text-status-warning-text">
          {t(
            'auto.components.right.sidebar.CloudShare.publicNote',
            'Anyone with this link can open port {{value0}} without signing in. Turn it off anytime in Ports → Shared links.',
            { value0: created.port }
          )}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.right.sidebar.CloudShare.teamNote',
            'Teammates open it from Orca, signed in to your team.'
          )}
        </p>
      )}
    </div>
  )
}
