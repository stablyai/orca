// The carousel's Generate face (the prompt icon, the run's progress, then the picture it made) and
// the description field that takes the swatch row's place under it.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Pencil, Sparkles, X } from 'lucide-react'
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
import { MAX_AVATAR_DESCRIPTION_CHARS } from '../../../../shared/avatar-generation/avatar-generation-contract'
import { BOT_EDIT_HINT } from './bot-edit-hint'
import { FieldNoteLine, sameNote, type FieldNote } from './AvatarGenerateFieldNote'
import { BotPictureRowFold } from './BotPictureRowFold'
import { useAvatarGeneration } from './use-avatar-generation'
import type { GeneratedAvatar, GenerateFaceOptions } from './use-avatar-generation'

const TILE = 'size-28 rounded-xl'

/** A picture the Generate slot shows: the one just made, or the user's own picture in use. */
export type SlotPicture = { src: string; description: string }

/**
 * The Generate face's state, shared by its tile and the line under the carousel. `applied` is the
 * user's own picture (generated earlier, uploaded, pasted or dropped); it holds the slot unless a
 * newer picture was just made. `onStart` runs as a picture is asked for (once the description passes
 * its checks), so a picture taken earlier and still being read can't replace it.
 *
 * A host above the popover (New bot, Import, a bot's picture button) keeps the face, so a run goes on
 * with the popover closed: `background`. Its other options: see useAvatarGeneration.
 */
export function useGenerateFace(
  /** False when a picture taken in since keeps the slot. `apply`: see AvatarRequestHost. */
  onResult: (result: GeneratedAvatar, apply: boolean) => boolean,
  applied: SlotPicture | null,
  onStart?: () => void,
  options: GenerateFaceOptions = {}
) {
  // A picture taken in after the last one made (an upload, an undo) wins the slot back.
  const [superseded, setSuperseded] = useState(false)
  const generation = useAvatarGeneration(
    (made, apply) => {
      setSuperseded(!onResult(made, apply))
    },
    onStart,
    options
  )
  const made = generation.result && !superseded ? generation.result : null
  const picture: SlotPicture | null = made
    ? { src: `data:image/png;base64,${made.png}`, description: made.description }
    : applied
  const [description, setDescription] = useState('')
  // Editing reopens the description field under a picture already made.
  const [editing, setEditing] = useState(false)
  // Bumped to move focus into the field; `select` also selects its text for retyping.
  const [focus, setFocus] = useState<{ count: number; select: boolean }>({
    count: 0,
    select: false
  })
  // The field folds to one line of description while the slot holds a picture.
  const folded = picture !== null && !editing && generation.run.kind === 'idle'
  return {
    ...generation,
    /** The run goes on with the picker closed. */
    background: options.background ?? false,
    /** The picture just made, unless another was taken in since. */
    made,
    picture,
    /** A picture taken in since wins the slot back; safe to call while rendering. */
    supersede: () => setSuperseded(true),
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
    },
    /** As if just mounted: a run still going is released, and the description cleared. */
    reset: () => {
      generation.reset()
      setSuperseded(false)
      setDescription('')
      setEditing(false)
    }
  }
}

export type GenerateFace = ReturnType<typeof useGenerateFace>

/** The face beside the current one: the picture made, or the Generate entry. */
export function GenerateFaceThumb({ face }: { face: GenerateFace }): React.JSX.Element {
  return face.picture ? (
    <img src={face.picture.src} alt="" className={cn(TILE, 'object-cover')} />
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

const HINT_BUTTON = cn(
  TILE,
  'group/edit relative block overflow-hidden outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
)

/** The same hover and focus hint as the picture button that opens this picker. */
function HintOverlay({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/55 text-white',
        BOT_EDIT_HINT
      )}
    >
      {children}
    </span>
  )
}

/**
 * The current face: progress (hover to cancel), the picture made (hover to edit its
 * description), or the prompt icon.
 */
export function GenerateFaceTile({ face }: { face: GenerateFace }): React.JSX.Element {
  const t = useTranslate()
  const { run } = face
  if (run.kind === 'running') {
    // Hover or focus swaps the spinner for an X and the word for Cancel, in the same spot.
    const AT_REST = 'group-hover/edit:hidden group-focus-visible/edit:hidden'
    const ON_HOVER = 'hidden group-hover/edit:inline group-focus-visible/edit:inline'
    return (
      <button
        type="button"
        aria-label={t('bots.avatar.generate.cancelRunning', 'Cancel generating')}
        onClick={face.cancel}
        className={HINT_BUTTON}
      >
        <PromptTile role="status">
          <span className="flex size-6 items-center justify-center">
            <LoadingSpinner className={cn('size-6', AT_REST)} />
            <X className={cn('size-6', ON_HOVER)} strokeWidth={1.75} />
          </span>
          <span className={AT_REST}>{t('bots.avatar.generate.generating', 'Generating…')}</span>
          <span className={ON_HOVER}>{t('bots.avatar.generate.cancel', 'Cancel')}</span>
          {face.background ? (
            // Closing the picker doesn't stop the run; the picture lands on its own.
            <span
              className={cn(
                '-mt-1 text-[11px] leading-4 whitespace-nowrap text-muted-foreground',
                AT_REST
              )}
            >
              {t('bots.avatar.generate.closeAnytime', 'Close anytime')}
            </span>
          ) : null}
        </PromptTile>
      </button>
    )
  }
  if (face.picture) {
    return (
      <button
        type="button"
        aria-label={t('bots.avatar.generate.edit', 'Edit description')}
        onClick={face.edit}
        className={HINT_BUTTON}
      >
        <img src={face.picture.src} alt="" className="size-full object-cover" />
        <HintOverlay>
          <Pencil className="size-4" />
        </HintOverlay>
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
  const running = face.run.kind === 'running'
  // Esc cancels a run, or folds the field back under the picture.
  const onEscape = running
    ? face.cancel
    : face.editing && face.picture !== null
      ? () => face.setEditing(false)
      : null
  const latestOnEscape = useRef(onEscape)
  useEffect(() => {
    latestOnEscape.current = onEscape
  })
  const handlesEscape = onEscape !== null
  useEffect(() => {
    if (!handlesEscape) {
      return
    }
    // Dialogs and popovers dismiss on a document capture listener, so this runs earlier, on
    // window, and marks the key handled.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && event.target === ref.current) {
        event.preventDefault()
        latestOnEscape.current?.()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [handlesEscape])
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
  const ready = face.description.trim().length > 0 && !running
  return (
    <div className="flex flex-col rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
      <textarea
        ref={ref}
        value={face.description}
        // Read-only, not disabled, so focus stays and Esc can cancel.
        readOnly={running}
        maxLength={MAX_AVATAR_DESCRIPTION_CHARS}
        placeholder={t('bots.avatar.generate.placeholder', "Describe your bot's look…")}
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
        className="scrollbar-sleek block max-h-[122px] min-h-[46px] w-full resize-none bg-transparent px-2.5 pt-2 text-[13px] leading-[19px] text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground read-only:text-muted-foreground"
      />
      {/* The agent glyph and the send button's edge both sit at the text's 10px side inset; the
          button's bottom matches the text's 8px top inset. */}
      <div className="flex items-center justify-between pt-1 pr-2.5 pb-2 pl-1.5">
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
    run.kind === 'error'
      ? { failure: run.failure, agent: run.agent ?? face.agent }
      : signedOut
        ? { failure: 'signed-out', agent: face.agent }
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
        <p className="flex min-h-7 items-center justify-center px-2 py-1">
          {/* Up to two lines; the full description shows on hover. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-description={t('bots.avatar.generate.edit', 'Edit description')}
                onClick={face.edit}
                className="line-clamp-2 max-w-full cursor-text rounded-sm text-center text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {face.picture?.description}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4} className="max-w-xs">
              {face.picture?.description}
            </TooltipContent>
          </Tooltip>
        </p>
      </BotPictureRowFold>
      {/* Inset by the popover's 12px content padding; the carousel's 4px of slack under its tiles
          plus pt-2 makes the gap above 12px too. */}
      <BotPictureRowFold open={!face.folded} className="px-3 pt-2 pb-3">
        <DescriptionField face={face} />
        <BotPictureRowFold open={note !== null}>
          {shownNote ? <FieldNoteLine note={shownNote} /> : null}
        </BotPictureRowFold>
      </BotPictureRowFold>
    </>
  )
}
