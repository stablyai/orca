// The line under the Generate description field: why the last run made no picture, or that no
// agent here can make one yet.
import React, { useEffect, useRef, useState } from 'react'
import { Trans } from 'react-i18next'
import { CircleAlert } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { cn } from '@/lib/class-names'
import {
  AVATAR_IMAGE_AGENTS,
  type AvatarGenerationFailure,
  type AvatarImageAgent
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { LineAction } from './BotPictureIntakeLine'

function useFailureMessage(): (failure: AvatarGenerationFailure, agent: string) => string {
  const t = useTranslate()
  return (failure, agent) => {
    switch (failure) {
      case 'signed-out':
        return t(
          'bots.avatar.generate.signedOut',
          "{{agent}} isn't signed in. Sign in to it, then try again.",
          { agent }
        )
      case 'usage-limit':
        return t(
          'bots.avatar.generate.usageLimit',
          '{{agent}} hit its usage limit. Try again later.',
          { agent }
        )
      case 'no-image':
        return t(
          'bots.avatar.generate.noImage',
          "{{agent}} didn't make an image. Try rewording your description.",
          { agent }
        )
      case 'timed-out':
        return t('bots.avatar.generate.timedOut', '{{agent}} took too long. Try again.', {
          agent
        })
      case 'unavailable':
        return t('bots.avatar.generate.unavailable', 'No installed agent can make images.')
      case 'failed':
      case 'canceled':
        return t('bots.avatar.generate.failed', "{{agent}} couldn't make an image. Try again.", {
          agent
        })
    }
  }
}

/** Why the last run made no picture, for the line under the field. */
export type FieldNote = { failure: AvatarGenerationFailure; agent: AvatarImageAgent | null }

export function sameNote(a: FieldNote, b: FieldNote | null): boolean {
  return b !== null && a.failure === b.failure && a.agent === b.agent
}

/** Generate was pressed with no signed-in agent: `nudge` counts the presses. Each one moves focus to
 *  Check again (which reads out the line it sits in) and briefly brings the line forward. */
function useNudge(nudge: number): {
  emphasized: boolean
  actionRef: React.RefObject<HTMLButtonElement | null>
} {
  const actionRef = useRef<HTMLButtonElement>(null)
  const [emphasized, setEmphasized] = useState(false)
  // Only presses made while this line shows: one that mounts later doesn't take focus.
  const seen = useRef(nudge)
  useEffect(() => {
    if (nudge === seen.current) {
      return
    }
    seen.current = nudge
    actionRef.current?.focus({ preventScroll: true })
    setEmphasized(true)
    const timer = setTimeout(() => setEmphasized(false), 1200)
    return () => clearTimeout(timer)
  }, [nudge])
  return { emphasized, actionRef }
}

function CheckAgain({
  actionRef,
  describedBy,
  onRecheck
}: {
  actionRef: React.RefObject<HTMLButtonElement | null>
  describedBy: string
  onRecheck: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <LineAction ref={actionRef} aria-describedby={describedBy} onClick={onRecheck}>
      {t('bots.avatar.generate.checkAgain', 'Check again')}
    </LineAction>
  )
}

export function FieldNoteLine({
  note,
  nudge = 0,
  onRecheck
}: {
  note: FieldNote
  nudge?: number
  /** Offered on a sign-in note: signing in elsewhere shows here only once checked again. */
  onRecheck?: () => void
}): React.JSX.Element {
  const failureMessage = useFailureMessage()
  const { emphasized, actionRef } = useNudge(nudge)
  const id = React.useId()
  const recheck = note.failure === 'signed-out' ? onRecheck : undefined
  return (
    <p
      role="alert"
      className={cn(
        'mt-1.5 flex items-start gap-1.5 rounded-sm px-0.5 text-xs leading-snug text-destructive transition-colors',
        emphasized && 'bg-destructive/10'
      )}
    >
      <CircleAlert className="mt-px size-3.5 shrink-0" />
      <span>
        <span id={id}>
          {failureMessage(note.failure, note.agent ? getAgentLabel(note.agent) : '')}
        </span>
        {recheck ? (
          <>
            {' '}
            <CheckAgain actionRef={actionRef} describedBy={id} onRecheck={recheck} />
          </>
        ) : null}
      </span>
    </p>
  )
}

/** No agent to run: the first check (or Check again) is still out, or none was found here. */
export type GeneratorState = 'checking' | 'none'

function AgentDocsLink({
  href,
  children
}: {
  href?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={openAppHttpLinkFromAnchor}
      className="rounded-sm underline decoration-current/40 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {children}
    </a>
  )
}

/** Says plainly that Generate needs an image agent here: each name opens its install and sign-in
 *  page, and Check again picks one up once set up. */
export function GeneratorLine({
  state,
  nudge = 0,
  onRecheck
}: {
  state: GeneratorState
  nudge?: number
  onRecheck: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { emphasized, actionRef } = useNudge(nudge)
  const id = React.useId()
  const catalog = getAgentCatalog()
  const [first, second] = AVATAR_IMAGE_AGENTS.map((agent) => ({
    label: getAgentLabel(agent),
    href: catalog.find((entry) => entry.id === agent)?.homepageUrl
  }))
  const line = cn(
    'mt-1.5 rounded-sm px-0.5 text-xs leading-snug transition-colors',
    emphasized ? 'bg-muted text-foreground' : 'text-muted-foreground'
  )
  if (state === 'checking') {
    return (
      <p role="status" className={cn(line, 'flex items-center gap-1.5')}>
        <LoadingSpinner className="size-3 shrink-0" />
        {t('bots.avatar.generate.checking', 'Looking for {{first}} or {{second}}…', {
          first: first?.label,
          second: second?.label
        })}
      </p>
    )
  }
  return (
    <p role="status" className={line}>
      <span id={id}>
        <Trans
          i18n={i18n}
          defaults={t(
            'bots.avatar.generate.noneLinked',
            'To generate a picture, install <first>{{first}}</first> or <second>{{second}}</second> on this computer and sign in.',
            { first: first?.label, second: second?.label }
          )}
          components={{
            first: <AgentDocsLink href={first?.href} />,
            second: <AgentDocsLink href={second?.href} />
          }}
        />
      </span>{' '}
      <CheckAgain actionRef={actionRef} describedBy={id} onRecheck={onRecheck} />
    </p>
  )
}
