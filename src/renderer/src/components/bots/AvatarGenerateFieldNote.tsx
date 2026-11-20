// The line under the Generate description field: why the last run made no picture.
import React from 'react'
import { CircleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import type {
  AvatarGenerationFailure,
  AvatarImageAgent
} from '../../../../shared/avatar-generation/avatar-generation-contract'

function useFailureMessage(): (failure: AvatarGenerationFailure, agent: string) => string {
  const t = useTranslate()
  return (failure, agent) => {
    switch (failure) {
      case 'real-person':
        return t(
          'bots.avatar.generate.realPerson',
          "Avatars can't show real people. Describe a character instead."
        )
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

export function FieldNoteLine({ note }: { note: FieldNote }): React.JSX.Element {
  const failureMessage = useFailureMessage()
  return (
    <p
      role="alert"
      className="mt-1.5 flex items-start gap-1.5 px-0.5 text-xs leading-snug text-destructive"
    >
      <CircleAlert className="mt-px size-3.5 shrink-0" />
      {failureMessage(note.failure, note.agent ? getAgentLabel(note.agent) : '')}
    </p>
  )
}
