import { useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { SkillRow } from './SkillRow'
import { SkillDetailDialog } from './SkillDetailDialog'
import {
  isSkillShareEligible,
  selectedShareSkillNameKeys,
  skillShareEligibilityReason
} from './skill-share-selection'
import { isSkillDeleteEligible, skillDeleteEligibilityReason } from './skill-delete-selection'

const OPTION_SELECTOR = '[role="option"]'

function moveOptionFocus(listbox: HTMLElement | null, from: HTMLElement, step: number): void {
  const options = [...(listbox?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? [])]
  options[options.indexOf(from) + step]?.focus()
}

function focusEdgeOption(listbox: HTMLElement | null, edge: 'first' | 'last'): void {
  const options = [...(listbox?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? [])]
  ;(edge === 'first' ? options.at(0) : options.at(-1))?.focus()
}

export function SkillsList({
  skills,
  allSkills,
  local,
  agentByRootPath,
  selectedIds,
  selectionMode,
  deleteSupported,
  deleteUnsupportedReason,
  onSelectedChange,
  onSelectResults,
  onShare,
  onDelete
}: {
  skills: readonly DiscoveredSkill[]
  allSkills: readonly DiscoveredSkill[]
  local: boolean
  agentByRootPath: ReadonlyMap<string, string>
  selectedIds: ReadonlySet<string>
  selectionMode: 'share' | 'delete' | null
  /** False while the runtime target is unresolved or the host predates
   *  `skills.delete.v1`; the action disables with a reason rather than issuing
   *  an RPC nothing answers. */
  deleteSupported: boolean
  deleteUnsupportedReason: string | null
  onSelectedChange: (skillId: string, selected: boolean) => void
  onSelectResults: (results: readonly DiscoveredSkill[]) => void
  onShare: (skill: DiscoveredSkill) => void
  onDelete: (skill: DiscoveredSkill) => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  // Why: an id survives filtering; an index would silently anchor a shift-click
  // range to whatever row later landed in that slot.
  const anchorIdRef = useRef<string | null>(null)
  const [detailSkill, setDetailSkill] = useState<DiscoveredSkill | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const selectedNames = selectedShareSkillNameKeys(allSkills, selectedIds)
  const focusTargetId = skills.some((skill) => skill.id === focusedId) ? focusedId : skills[0]?.id

  const isMac = navigator.userAgent.includes('Mac')

  const deleteReasonFor = (skill: DiscoveredSkill): string | null =>
    deleteSupported ? skillDeleteEligibilityReason(skill) : deleteUnsupportedReason

  const handleSelection = (index: number, selected: boolean, range: boolean): void => {
    const skill = skills[index]
    const anchorIndex = skills.findIndex((candidate) => candidate.id === anchorIdRef.current)
    if (range && selected && anchorIndex !== -1) {
      const [from, to] = [anchorIndex, index].sort((a, b) => a - b)
      onSelectResults(skills.slice(from, to + 1))
      return
    }
    anchorIdRef.current = skill.id
    onSelectedChange(skill.id, selected)
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const option = event.currentTarget
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveOptionFocus(listRef.current, option, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveOptionFocus(listRef.current, option, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusEdgeOption(listRef.current, 'first')
    } else if (event.key === 'End') {
      event.preventDefault()
      focusEdgeOption(listRef.current, 'last')
    } else if (
      selectionMode &&
      event.key.toLowerCase() === 'a' &&
      (isMac ? event.metaKey : event.ctrlKey)
    ) {
      event.preventDefault()
      onSelectResults(skills)
    }
  }

  return (
    <>
      <SkillDetailDialog
        skill={detailSkill}
        agentByRootPath={agentByRootPath}
        shareable={detailSkill ? isSkillShareEligible(detailSkill, local) : false}
        deletable={detailSkill ? deleteSupported && isSkillDeleteEligible(detailSkill) : false}
        deleteDisabledReason={detailSkill ? deleteReasonFor(detailSkill) : null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailSkill(null)
          }
        }}
        onShare={() => {
          if (detailSkill) {
            onShare(detailSkill)
            setDetailSkill(null)
          }
        }}
        onDelete={() => {
          if (detailSkill) {
            onDelete(detailSkill)
            setDetailSkill(null)
          }
        }}
      />
      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable={selectionMode !== null || undefined}
        aria-label={translate('auto.components.skills.SkillsList.listLabel', 'Skills')}
        aria-orientation="vertical"
      >
        {skills.map((skill, index) => {
          const duplicateNameSelected =
            !selectedIds.has(skill.id) && selectedNames.has(skill.name.toLocaleLowerCase('en-US'))
          const shareEligible = isSkillShareEligible(skill, local)
          const deleteEligible = isSkillDeleteEligible(skill)
          const deleting = selectionMode === 'delete'
          return (
            <SkillRow
              key={skill.id}
              skill={skill}
              selectionMode={selectionMode !== null}
              selected={selectedIds.has(skill.id)}
              selectable={deleting ? deleteEligible : shareEligible && !duplicateNameSelected}
              shareable={shareEligible}
              deletable={deleteSupported && deleteEligible}
              deleteDisabledReason={deleteReasonFor(skill)}
              disabledLabel={
                deleting
                  ? translate('auto.components.skills.SkillRow.notDeletable', 'Not deletable')
                  : translate('auto.components.skills.SkillRow.notShareable', 'Not shareable')
              }
              // Why: on a remote runtime every row shares one *share* cause, so
              // the page states it once above the list instead of on all 114
              // rows. Delete is valid on a remote host, so it keeps its own.
              disabledReason={
                deleting
                  ? skillDeleteEligibilityReason(skill)
                  : local
                    ? skillShareEligibilityReason(skill, local, duplicateNameSelected)
                    : null
              }
              focusable={focusTargetId === skill.id}
              onFocus={() => setFocusedId(skill.id)}
              onOpenDetail={() => setDetailSkill(skill)}
              onSelectionChange={(selected, range) => handleSelection(index, selected, range)}
              onShare={() => onShare(skill)}
              onDelete={() => onDelete(skill)}
              onKeyDown={onListKeyDown}
            />
          )
        })}
      </div>
    </>
  )
}
