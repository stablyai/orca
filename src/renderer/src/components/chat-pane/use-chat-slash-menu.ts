// FEATURE B: the jcode chat composer's "/" menu state, extracted from
// ChatComposer so the component stays under the max-lines budget. Owns: the
// "/query" derivation, the (lazily fetched) per-pane skill list, the two filtered
// groups (orca commands + skills), the flat keyboard index, and the open/index
// sync. The composer renders the popover + textarea and delegates row activation
// back here via runSlashCommand.
import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { JcodeSkill } from '../../../../shared/jcode-chat-types'
import { filterSlashGroups, type SlashCommand } from './chat-slash-commands'

export type ChatSlashMenu = {
  /** Whether the "/" popover is open. */
  slashOpen: boolean
  /** Active (highlighted) flat row index across both groups. */
  slashIndex: number
  setSlashIndex: React.Dispatch<React.SetStateAction<number>>
  setSlashOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** Filtered orca quick-command rows. */
  commands: SlashCommand[]
  /** Filtered skill rows. */
  skills: SlashCommand[]
  /** commands ++ skills, for keyboard nav (matches popover flat index). */
  flatMatches: SlashCommand[]
  /** True when a remote project's project-local skills couldn't be read. */
  degraded: boolean
  /** Activate a row: insert a template, arm a skill, or run an action. */
  runSlashCommand: (command: SlashCommand) => void
}

export function useChatSlashMenu({
  value,
  cwd,
  worktreeId,
  textareaRef,
  onChange,
  onSlashAction,
  onSelectSkill
}: {
  value: string
  cwd?: string
  worktreeId?: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onChange: (next: string) => void
  onSlashAction: (action: 'clear' | 'resume') => void
  onSelectSkill: (skillName: string | null) => void
}): ChatSlashMenu {
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [skills, setSkills] = useState<JcodeSkill[]>([])
  const [degraded, setDegraded] = useState(false)

  // The draft is a "/query" when it starts with "/" and has no space/newline yet.
  const isSlashDraft = value.startsWith('/') && !value.includes(' ') && !value.includes('\n')
  const slashQuery = isSlashDraft ? value.slice(1).toLowerCase() : null

  // Fetch the skill list lazily when the "/" menu is active (and on cwd/worktree
  // change). Cheap to refetch; gated so we don't touch the filesystem/SSH unless
  // the user actually opens the menu.
  useEffect(() => {
    if (!isSlashDraft) {
      return
    }
    let cancelled = false
    void window.api.jcodeChat.listSkills({ cwd, worktreeId }).then((result) => {
      if (cancelled) {
        return
      }
      setSkills(result.skills)
      setDegraded(result.degraded === true)
    })
    return () => {
      cancelled = true
    }
  }, [isSlashDraft, cwd, worktreeId])

  const groups =
    slashQuery === null ? { commands: [], skills: [] } : filterSlashGroups(slashQuery, skills)
  const flatMatches: SlashCommand[] = [...groups.commands, ...groups.skills]

  // Open/index sync: open while there is a query with matches; reset highlight.
  useEffect(() => {
    const shouldOpen = slashQuery !== null && flatMatches.length > 0
    setSlashOpen(shouldOpen)
    if (shouldOpen) {
      setSlashIndex(0)
    }
  }, [slashQuery, flatMatches.length])

  const runSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.kind === 'template') {
        onChange(command.template)
      } else if (command.kind === 'skill') {
        // Arm the skill for the NEXT send (main injects its SKILL.md body). Clear
        // the "/query" draft so the user can type their message; a chip shows it.
        onSelectSkill(command.skillName)
        onChange('')
      } else {
        // Action: clear the "/command" draft, then run it.
        onChange('')
        onSlashAction(command.action)
      }
      setSlashOpen(false)
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [onChange, onSlashAction, onSelectSkill, textareaRef]
  )

  return {
    slashOpen,
    slashIndex,
    setSlashIndex,
    setSlashOpen,
    commands: groups.commands,
    skills: groups.skills,
    flatMatches,
    degraded,
    runSlashCommand
  }
}
