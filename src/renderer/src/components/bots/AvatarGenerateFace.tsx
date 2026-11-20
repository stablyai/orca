// The carousel's Generate face (the prompt icon, the run's progress, then the picture it made) and
// the description field that takes the swatch row's place under it.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Pencil, Sparkles } from 'lucide-react'
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
import { MAX_AVATAR_DESCRIPTION_CHARS } from '../../../../shared/avatar-generation/avatar-generation-contract'
import { BOT_EDIT_HINT } from './bot-edit-hint'
import { FieldNoteLine, sameNote, type FieldNote } from './AvatarGenerateFieldNote'
import { BotPictureRowFold } from './BotPictureRowFold'
import { useAvatarGeneration, type GeneratedAvatar } from './use-avatar-generation'

const TILE = 'size-28 rounded-xl'

/** The Generate face's state, shared by its tile and the caption line under the carousel. */
export function useGenerateFace(onResult: (result: GeneratedAvatar) => void) {
  const generation = useAvatarGeneration(onResult)
  const [description, setDescription] = useState('')
  // Editing reopens the description field under a picture already made.
  const [editing, setEditing] = useState(false)
  // Bumped to move focus into the field; `select` also selects its text for retyping.
  const [focus, setFocus] = useState<{ count: number; select: boolean }>({
    count: 0,
    select: false
  })
  // The field folds to one line of description once a picture is made.
  const folded = generation.result !== null && !editing && generation.run.kind === 'idle'
  return {
    ...generation,
    description,
    setDescription: (next: string) => {
      setDescription(next)
      generation.clearError()
    },
    editing,
    setEditing,
    folded,
    focus,
    focusField: (select: boolean) => setFocus((now) => ({ count: now.count + 1, select })),
    edit: () => {
      setEditing(true)
      setFocus((now) => ({ count: now.count + 1, select: true }))
    },
    generate: () => {
      setEditing(false)
      generation.generate(description)
    }
  }
}

export type GenerateFace = ReturnType<typeof useGenerateFace>

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
    <PromptTile />
  )
}

function PromptTile({
  role,
  children
}: {
  role?: 'status'
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      role={role}
      className={cn(
        TILE,
        'flex flex-col items-center justify-center gap-1.5 border-[1.5px] border-dashed border-foreground/40 bg-muted text-xs text-foreground'
      )}
    >
      {children ?? <Sparkles className="size-7" strokeWidth={1.5} />}
    </span>
  )
}

/** The current face: progress, the picture made (hover to edit its description), or the prompt icon. */
export function GenerateFaceTile({ face }: { face: GenerateFace }): React.JSX.Element {
  const t = useTranslate()
  if (face.run.kind === 'running') {
    return (
      <PromptTile role="status">
        <LoadingSpinner className="size-6" />
        <Elapsed since={face.run.startedAt} />
      </PromptTile>
    )
  }
  if (face.result) {
    return (
      <button
        type="button"
        aria-label={t('bots.avatar.generate.edit', 'Edit description')}
        onClick={face.edit}
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
  return <PromptTile />
}

function AgentMenu({
  face,
  disabled
}: {
  face: GenerateFace
  disabled: boolean
}): React.JSX.Element {
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
              disabled={disabled}
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
          <DropdownMenuItem
            key={entry.agent}
            onSelect={() => {
              face.selectAgent(entry.agent)
              face.focusField(false)
            }}
          >
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

function DescriptionField({ face }: { face: GenerateFace }): React.JSX.Element {
  const t = useTranslate()
  const ref = useRef<HTMLTextAreaElement>(null)
  const { count, select } = face.focus
  const foldsOnEscape = face.editing && face.result !== null
  const { setEditing } = face
  useEffect(() => {
    if (!foldsOnEscape) {
      return
    }
    // Esc folds the field back under the picture. Dialogs and popovers dismiss on a document
    // capture listener, so this runs earlier, on window, and marks the key handled.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && event.target === ref.current) {
        event.preventDefault()
        setEditing(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [foldsOnEscape, setEditing])
  useEffect(() => {
    const box = ref.current
    if (count === 0 || !box) {
      return
    }
    // The field may still be folding open; it takes focus without scrolling the dialog.
    box.focus({ preventScroll: true })
    if (select) {
      box.select()
    } else {
      box.setSelectionRange(box.value.length, box.value.length)
    }
  }, [count, select])
  const running = face.run.kind === 'running'
  const ready = face.description.trim().length > 0 && !running
  return (
    <div className="flex flex-col rounded-lg border border-input bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
      <textarea
        ref={ref}
        value={face.description}
        disabled={running}
        maxLength={MAX_AVATAR_DESCRIPTION_CHARS}
        placeholder={t('bots.avatar.generate.placeholder', 'Describe a picture…')}
        aria-label={t('bots.avatar.generate.describe', 'Picture description')}
        onChange={(event) => face.setDescription(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (ready) {
              face.generate()
            }
          }
        }}
        // Two lines at rest, growing to six, then scrolling.
        className="scrollbar-sleek block max-h-[122px] min-h-[46px] w-full resize-none bg-transparent px-2.5 pt-2 text-[13px] leading-[19px] text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground disabled:text-muted-foreground"
      />
      <div className="flex items-center justify-between px-1.5 pt-1 pb-1.5">
        <AgentMenu face={face} disabled={running} />
        <Button
          type="button"
          size="icon-xs"
          disabled={!ready}
          aria-label={t('bots.avatar.generate.button', 'Generate')}
          onClick={face.generate}
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
  )
}

/**
 * What takes the swatch row's place while Generate is the current face: the description field
 * with progress and Cancel or an error under it, folded to one line of description once a
 * picture is made.
 */
export function GenerateField({ face }: { face: GenerateFace }): React.JSX.Element {
  const t = useTranslate()
  const { run } = face
  const signedOut =
    run.kind === 'idle' &&
    face.agents.find((entry) => entry.agent === face.agent)?.status === 'signed-out'
  const note: FieldNote | null =
    run.kind === 'running'
      ? { kind: 'running', agent: run.agent }
      : run.kind === 'error'
        ? { kind: 'failure', failure: run.failure, agent: run.agent ?? face.agent }
        : signedOut
          ? { kind: 'failure', failure: 'signed-out', agent: face.agent }
          : null
  // The last note stays while its row folds away, so the row shrinks instead of vanishing.
  const [lastNote, setLastNote] = useState<FieldNote | null>(note)
  if (note && !sameNote(note, lastNote)) {
    setLastNote(note)
  }
  const shownNote = note ?? lastNote
  return (
    <>
      <BotPictureRowFold open={face.folded}>
        <p className="flex h-7 items-center justify-center px-2">
          <button
            type="button"
            title={t('bots.avatar.generate.edit', 'Edit description')}
            onClick={face.edit}
            className="max-w-full cursor-text truncate rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {face.result?.description}
          </button>
        </p>
      </BotPictureRowFold>
      <BotPictureRowFold open={!face.folded} className="px-1 pt-2 pb-1">
        <DescriptionField face={face} />
        <BotPictureRowFold open={note !== null}>
          {shownNote ? <FieldNoteLine note={shownNote} onCancel={face.cancel} /> : null}
        </BotPictureRowFold>
      </BotPictureRowFold>
    </>
  )
}
