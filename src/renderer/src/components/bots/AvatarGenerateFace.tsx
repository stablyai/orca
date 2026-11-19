// The carousel's Generate face: a description box, then the run's progress, then the picture it made.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, CircleAlert, Pencil, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { AgentIconLabel } from '@/components/agent/agent-combobox-items'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { cn } from '@/lib/class-names'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import {
  MAX_AVATAR_DESCRIPTION_CHARS,
  type AvatarGenerationFailure
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { BOT_EDIT_HINT } from './bot-edit-hint'
import { useAvatarGeneration, type GeneratedAvatar } from './use-avatar-generation'

const TILE = 'size-28 rounded-xl'

/** The Generate face's state, shared by its tile and the caption line under the carousel. */
export function useGenerateFace(onResult: (result: GeneratedAvatar) => void) {
  const generation = useAvatarGeneration(onResult)
  const [description, setDescription] = useState('')
  // Editing reopens the description over a picture already made.
  const [editing, setEditing] = useState(false)
  const showsResult = generation.result !== null && !editing && generation.run.kind === 'idle'
  return {
    ...generation,
    description,
    setDescription: (next: string) => {
      setDescription(next)
      generation.clearError()
    },
    editing,
    setEditing,
    showsResult,
    generate: () => {
      setEditing(false)
      generation.generate(description)
    }
  }
}

export type GenerateFace = ReturnType<typeof useGenerateFace>

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

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  // A visible clock; hidden windows skip ticks and catch up when shown.
  useEffect(
    () => installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 1000 }),
    []
  )
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <span className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

/** The face beside the current one: the picture made, or the Generate entry. */
export function GenerateFaceThumb({ face }: { face: GenerateFace }): React.JSX.Element {
  return face.result ? (
    <img src={`data:image/png;base64,${face.result.png}`} alt="" className={TILE} />
  ) : (
    <span
      className={cn(
        TILE,
        'flex items-center justify-center border-[1.5px] border-dashed border-foreground/40 bg-muted text-foreground'
      )}
    >
      <Sparkles className="size-7" strokeWidth={1.5} />
    </span>
  )
}

function AgentMenu({ face }: { face: GenerateFace }): React.JSX.Element | null {
  const t = useTranslate()
  const { agent, agents } = face
  // One agent needs no choice; the progress line still names it.
  if (!agent || agents.length < 2) {
    return <span />
  }
  const label = getAgentLabel(agent)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('bots.avatar.generate.agent', 'Generate with {{agent}}', {
                agent: label
              })}
            >
              <AgentIcon agent={agent} size={14} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t('bots.avatar.generate.agent', 'Generate with {{agent}}', { agent: label })}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-36">
        {agents.map((entry) => (
          <DropdownMenuItem key={entry.agent} onSelect={() => face.selectAgent(entry.agent)}>
            <Check
              className={cn(
                'size-4 shrink-0 text-foreground',
                entry.agent === agent ? 'opacity-100' : 'opacity-0'
              )}
            />
            <AgentIconLabel
              icon={<AgentIcon agent={entry.agent} size={14} />}
              label={getAgentLabel(entry.agent)}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DescriptionBox({ face }: { face: GenerateFace }): React.JSX.Element {
  const t = useTranslate()
  const ref = useRef<HTMLTextAreaElement>(null)
  // Shown for editing: focused with the old description selected, so typing replaces it.
  useEffect(() => {
    ref.current?.focus()
    if (face.editing) {
      ref.current?.select()
    }
  }, [face.editing])
  const ready = face.description.trim().length > 0
  return (
    <span
      className={cn(
        TILE,
        'flex flex-col overflow-hidden border border-input bg-background text-left focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30'
      )}
    >
      <textarea
        ref={ref}
        value={face.description}
        maxLength={MAX_AVATAR_DESCRIPTION_CHARS}
        placeholder={t('bots.avatar.generate.placeholder', 'Describe a picture…')}
        aria-label={t('bots.avatar.generate.describe', 'Picture description')}
        onChange={(event) => face.setDescription(event.currentTarget.value)}
        onKeyDown={(event) => {
          // The carousel's own arrow keys must not move it while typing.
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.stopPropagation()
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            face.generate()
          }
          // Esc leaves editing for the picture, not the popover.
          if (event.key === 'Escape' && face.editing && face.result) {
            event.preventDefault()
            event.stopPropagation()
            face.setEditing(false)
          }
        }}
        className="scrollbar-sleek min-h-0 flex-1 resize-none bg-transparent px-2 pt-1.5 text-xs leading-snug text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span className="flex h-6.5 items-center justify-between px-1 pb-1">
        <AgentMenu face={face} />
        <Button
          type="button"
          size="icon-xs"
          disabled={!ready}
          aria-label={t('bots.avatar.generate.button', 'Generate')}
          onClick={face.generate}
        >
          <ArrowUp />
        </Button>
      </span>
    </span>
  )
}

/** The current face: progress, the picture made (hover to edit), or the description box. */
export function GenerateFaceTile({ face }: { face: GenerateFace }): React.JSX.Element {
  const t = useTranslate()
  if (face.run.kind === 'running') {
    return (
      <span
        role="status"
        className={cn(
          TILE,
          'flex flex-col items-center justify-center gap-1.5 border-[1.5px] border-dashed border-foreground/40 bg-muted text-xs text-foreground'
        )}
      >
        <LoadingSpinner className="size-6" />
        <Elapsed since={face.run.startedAt} />
      </span>
    )
  }
  if (face.showsResult && face.result) {
    return (
      <button
        type="button"
        aria-label={t('bots.avatar.generate.edit', 'Edit description')}
        onClick={() => face.setEditing(true)}
        className={cn(
          TILE,
          'group/edit relative overflow-hidden outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
        )}
      >
        <img src={`data:image/png;base64,${face.result.png}`} alt="" className="size-full" />
        {/* The same hint as the picture button that opens this picker. */}
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 text-white',
            BOT_EDIT_HINT
          )}
        >
          <Pencil className="size-4" />
        </span>
      </button>
    )
  }
  return <DescriptionBox face={face} />
}

/**
 * The caption line while the Generate face is current: progress with Cancel, an error, or the
 * description under the picture made; otherwise `children` (the upload line).
 */
export function GenerateFaceLine({
  face,
  children
}: {
  face: GenerateFace
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const failureMessage = useFailureMessage()
  const { run } = face
  if (run.kind === 'running') {
    return (
      <div className="mt-0.5 flex h-7 items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <LoadingSpinner className="size-3.5" />
          {t('bots.avatar.generate.running', 'Generating with {{agent}}…', {
            agent: getAgentLabel(run.agent)
          })}
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={face.cancel}>
          <X />
          {t('bots.avatar.generate.cancel', 'Cancel')}
        </Button>
      </div>
    )
  }
  const signedOut =
    run.kind === 'idle' &&
    face.agents.find((entry) => entry.agent === face.agent)?.status === 'signed-out'
  if (run.kind === 'error' || (signedOut && !face.showsResult)) {
    const agent = (run.kind === 'error' ? run.agent : undefined) ?? face.agent
    return (
      <p
        role="alert"
        className="mt-0.5 flex min-h-7 items-center justify-center gap-1.5 px-2 text-center text-xs text-destructive"
      >
        <CircleAlert className="size-3.5 shrink-0" />
        {failureMessage(
          run.kind === 'error' ? run.failure : 'signed-out',
          agent ? getAgentLabel(agent) : ''
        )}
      </p>
    )
  }
  if (face.showsResult && face.result) {
    return (
      <p className="mt-0.5 flex h-7 items-center justify-center px-2 text-xs text-muted-foreground">
        <span className="truncate">{face.result.description}</span>
      </p>
    )
  }
  return <>{children}</>
}
