import type React from 'react'
import type { Repo } from '../../../../shared/types'
import { isRepoHeaderActionTarget } from './project-header-drag'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree/ownership'

export function stopRepoHeaderKeyboardToggle(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.stopPropagation()
  }
}

export function handleRepoHeaderActionPointerDown(event: React.PointerEvent<HTMLElement>): void {
  event.stopPropagation()
}

export function handleRepoHeaderCollapseAffordancePointerDown(
  event: React.PointerEvent<HTMLElement>
): void {
  // Why: keep collapse-chevron clicks from arming the repo-header row drag.
  event.stopPropagation()
}

export function stopRepoHeaderMenuEvent(event: React.SyntheticEvent<HTMLElement>): void {
  event.stopPropagation()
}

export function shouldIgnoreRepoHeaderToggle(event: React.SyntheticEvent<HTMLElement>): boolean {
  return isRepoHeaderActionTarget(event.target, event.currentTarget)
}

export function getWorktreeVisibilityMenuLabel(repo: Repo): string {
  const visibility = effectiveExternalWorktreeVisibility(
    repo,
    isLegacyRepoForExternalWorktreeVisibility(repo)
  )
  return visibility === 'show' ? 'Hide non-Orca worktrees' : 'Show hidden worktrees'
}
