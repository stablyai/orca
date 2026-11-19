// The picker's Generate tab: pick an agent, describe an avatar, use the image it makes.
import React, { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { Check, CircleAlert, Pencil, RotateCw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import {
  AVATAR_IMAGE_AGENTS,
  MAX_AVATAR_DESCRIPTION_CHARS,
  type AvatarGenerationFailure,
  type AvatarImageAgent,
  type AvatarImageAgentStatus
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import type { AvatarGenerationState } from './use-avatar-generation'

function useFailureMessage(): (error: AvatarGenerationFailure, agent: string) => string {
  const t = useTranslate()
  return (error, agent) => {
    switch (error) {
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

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // A visible clock; hidden windows skip ticks and catch up when shown.
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 1000 })
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <span className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

function isAvatarImageAgent(agent: string): agent is AvatarImageAgent {
  return AVATAR_IMAGE_AGENTS.some((entry) => entry === agent)
}

export function AvatarGeneratePanel({
  agents,
  agent,
  onAgentChange,
  state,
  description,
  onDescriptionChange,
  onGenerate,
  onCancel,
  onEdit,
  onPick
}: {
  /** Installed agents that can make images; never empty here. */
  agents: AvatarImageAgentStatus[]
  agent: AvatarImageAgent
  onAgentChange: (agent: AvatarImageAgent) => void
  state: AvatarGenerationState
  description: string
  onDescriptionChange: (description: string) => void
  onGenerate: () => void
  onCancel: () => void
  /** Back to the description, leaving the options. */
  onEdit: () => void
  /** A data URL of the chosen option. */
  onPick: (image: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const failureMessage = useFailureMessage()
  // A run names its own agent; otherwise the picker's choice.
  const shownAgent =
    (state.kind === 'running' || state.kind === 'error' ? state.agent : undefined) ?? agent
  const agentLabel = getAgentLabel(shownAgent)
  const running = state.kind === 'running'
  const signedOut = agents.find((entry) => entry.agent === agent)?.status === 'signed-out'
  const catalog = getAgentCatalog()
  const choices = agents.flatMap(
    (entry) => catalog.find((candidate) => candidate.id === entry.agent) ?? []
  )
  return (
    <div className="flex flex-col gap-2">
      {/* The same agent picker as elsewhere, offering only agents that can make an image here. */}
      <AgentCombobox
        agents={choices}
        value={agent}
        onValueChange={(next) => {
          if (isAvatarImageAgent(next)) {
            onAgentChange(next)
          }
        }}
        disabled={running}
        allowNarrowTrigger
        triggerClassName="w-full"
      />
      {state.kind === 'result' ? (
        // Clicking the image uses it too, like the Use this button.
        <button
          type="button"
          onClick={() => onPick(state.src)}
          aria-label={t('bots.avatar.generate.use', 'Use this')}
          className="self-center overflow-hidden rounded-xl outline-none ring-offset-2 ring-offset-popover transition-shadow hover:ring-2 hover:ring-foreground/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <img src={state.src} alt="" className="size-32 object-cover" />
        </button>
      ) : (
        <Textarea
          value={description}
          onChange={(event) => onDescriptionChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (!running && description.trim()) {
                onGenerate()
              }
            }
          }}
          disabled={running}
          maxLength={MAX_AVATAR_DESCRIPTION_CHARS}
          rows={4}
          placeholder={t('bots.avatar.generate.placeholder', 'Describe your avatar…')}
          aria-label={t('bots.avatar.generate.describe', 'Avatar description')}
          className="resize-none"
        />
      )}
      {running ? (
        <div className="flex items-center gap-2">
          <div
            role="status"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <LoadingSpinner className="size-3.5" />
            <span className="truncate">
              {t('bots.avatar.generate.running', 'Generating with {{agent}}…', {
                agent: agentLabel
              })}
            </span>
            <Elapsed since={state.startedAt} />
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
            <X />
            {t('bots.avatar.generate.cancel', 'Cancel')}
          </Button>
        </div>
      ) : state.kind === 'result' ? (
        <div className="flex flex-col gap-1.5">
          <Button type="button" size="sm" onClick={() => onPick(state.src)}>
            <Check />
            {t('bots.avatar.generate.use', 'Use this')}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="xs" className="flex-1" onClick={onEdit}>
              <Pencil />
              {t('bots.avatar.generate.edit', 'Change description')}
            </Button>
            <Button type="button" variant="ghost" size="xs" className="flex-1" onClick={onGenerate}>
              <RotateCw />
              {t('bots.avatar.generate.again', 'Generate again')}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" size="sm" disabled={!description.trim()} onClick={onGenerate}>
          <Sparkles />
          {t('bots.avatar.generate.button', 'Generate')}
        </Button>
      )}
      {state.kind === 'error' || (signedOut && state.kind === 'idle') ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          {failureMessage(state.kind === 'error' ? state.failure : 'signed-out', agentLabel)}
        </p>
      ) : null}
    </div>
  )
}
