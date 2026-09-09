/**
 * The Office agent-skill picker's state, kept out of the component so it can be tested.
 *
 * Orca authors none of this content. `officecli` ships the skills and installs them per agent, and
 * the catalogue is read from `officecli skills list` rather than hardcoded — a tool update that
 * adds a skill must not silently make this UI wrong.
 */
import { useCallback, useEffect, useState } from 'react'
import type { OfficeHostOwner } from '../../../../shared/office-host-owner'
import type {
  OfficeErrorCode,
  OfficeSkill,
  OfficeSkillAgent,
  OfficeSkillInstallResult
} from '../../../../shared/office-preview-contracts'

export type OfficeSkillsCatalog =
  | { status: 'loading' }
  | { status: 'ready'; skills: OfficeSkill[]; agents: OfficeSkillAgent[] }
  | { status: 'unavailable'; code: OfficeErrorCode }

export type OfficeSkillsSelection = {
  skills: ReadonlySet<string>
  agents: ReadonlySet<string>
}

/** Every (skill, agent) pair the reader asked for. Empty when either side is unchosen. */
export function officeSkillInstallPairs(
  selection: OfficeSkillsSelection
): { skill: string; agent: string }[] {
  const pairs: { skill: string; agent: string }[] = []
  for (const skill of selection.skills) {
    for (const agent of selection.agents) {
      pairs.push({ skill, agent })
    }
  }
  return pairs
}

/** Per-pair reporting, so one agent refusing does not read as the whole action failing. */
export function summarizeOfficeSkillInstall(results: readonly OfficeSkillInstallResult[]): {
  installed: number
  failed: number
} {
  let installed = 0
  for (const result of results) {
    if (result.installed) {
      installed += 1
    }
  }
  return { installed, failed: results.length - installed }
}

export function useOfficeSkillsCatalog(owner: OfficeHostOwner | null): {
  catalog: OfficeSkillsCatalog
  reload: () => void
} {
  const [catalog, setCatalog] = useState<OfficeSkillsCatalog>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const ownerKey = owner ? JSON.stringify(owner) : null

  useEffect(() => {
    if (!owner) {
      setCatalog({ status: 'unavailable', code: 'OFFICE_HOST_UNREACHABLE' })
      return
    }
    let disposed = false
    setCatalog({ status: 'loading' })
    void window.api.office
      .skillsList({ owner })
      .then((outcome) => {
        if (disposed) {
          return
        }
        setCatalog(
          outcome.ok
            ? { status: 'ready', skills: outcome.skills, agents: outcome.agents }
            : { status: 'unavailable', code: outcome.code }
        )
      })
      .catch(() => {
        if (!disposed) {
          setCatalog({ status: 'unavailable', code: 'OFFICE_HOST_UNREACHABLE' })
        }
      })
    return () => {
      disposed = true
    }
  }, [attempt, owner, ownerKey])

  const reload = useCallback(() => setAttempt((count) => count + 1), [])
  return { catalog, reload }
}

export function toggleInSet(current: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(current)
  if (!next.delete(value)) {
    next.add(value)
  }
  return next
}
