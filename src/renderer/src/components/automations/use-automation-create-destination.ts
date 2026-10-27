/** Capture the displayed destination in state for the dialog lifetime; re-pair/re-registration must report movement instead of silently changing the chosen machine. */

import { useCallback, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import type { AutomationAuthorityRepoTables } from './automation-authority-identity'
import {
  automationCreateEligibleProjects,
  automationCreateProjectMismatch,
  preselectAutomationCreateHost,
  resolveAutomationCreateDestination,
  revalidateAutomationCreateDestination,
  soleAutomationCreateHost,
  type AutomationCreateDestination,
  type AutomationCreateDestinationChoiceReason,
  type AutomationCreateDestinationResolution
} from './automation-create-destination'
import type { AutomationActionNotice } from './automation-row-action-dispatch'

export type AutomationCreateDestinationControl = {
  entries: readonly AutomationHostCatalogEntry[]
  resolution: AutomationCreateDestinationResolution
  onSelect: (stableKey: string) => void
  /** Projects the resolved destination can hold; the whole list until one resolves. */
  projects: readonly Repo[]
  /** Set when saving would move the record to another host; replaces the plain line. */
  moveWarning?: string | null
}

export type AutomationCreateDestinationCheck =
  | { ok: true; destination: AutomationCreateDestination }
  | { ok: false; notice: AutomationActionNotice }

export type AutomationCreateDestinationInput = {
  /** False whenever the dialog is closed or is not creating an Orca automation. */
  open: boolean
  catalog: AutomationHostCatalog
  entries: readonly AutomationHostCatalogEntry[]
  /** Non-null only when the list is filtered to one concrete host. */
  filterStableKey: string | null
  activeWorkspaceStableKey: string | null
  repoTables: AutomationAuthorityRepoTables
  projects: readonly Repo[]
}

export type AutomationCreateDestinationState = {
  control: AutomationCreateDestinationControl
  check: (projectId: string) => AutomationCreateDestinationCheck
}

function choiceMessage(reason: AutomationCreateDestinationChoiceReason): string {
  if (reason === 'orphan') {
    return translate(
      'auto.components.automations.createDestination.orphan',
      'Automations with no host cannot hold new ones. Choose a host to create this automation on.'
    )
  }
  if (reason === 'unavailable') {
    return translate(
      'auto.components.automations.createDestination.unavailable',
      'That host cannot hold a new automation yet. Choose another host to create this one on.'
    )
  }
  return translate(
    'auto.components.automations.createDestination.unselected',
    'Choose the host that stores and schedules this automation.'
  )
}

function ownerNotice(message: string): AutomationActionNotice {
  return { message, recovery: null, severity: 'owner' }
}

export function useAutomationCreateDestination(
  input: AutomationCreateDestinationInput
): AutomationCreateDestinationState {
  const {
    open,
    catalog,
    entries,
    filterStableKey,
    activeWorkspaceStableKey,
    repoTables,
    projects
  } = input
  const [captured, setCaptured] = useState<AutomationCreateDestination | null>(null)
  const [reason, setReason] = useState<AutomationCreateDestinationChoiceReason>('unselected')

  // Reset capture during render under change guards so a prior dialog’s owner never paints and updates converge.
  if (!open && (captured !== null || reason !== 'unselected')) {
    setCaptured(null)
    setReason('unselected')
  }
  if (open && !captured) {
    // Keep resolving until the first capture so late hydration can supply the intended host.
    const entry =
      preselectAutomationCreateHost(entries, filterStableKey, activeWorkspaceStableKey) ??
      soleAutomationCreateHost(entries, catalog.hydration)
    const resolved = resolveAutomationCreateDestination(entry)
    if (resolved.status === 'ready') {
      setCaptured(resolved)
    } else if (resolved.reason !== reason) {
      setReason(resolved.reason)
    }
  }

  const onSelect = useCallback(
    (stableKey: string) => {
      const resolved = resolveAutomationCreateDestination(
        entries.find((entry) => entry.stableKey === stableKey)
      )
      setCaptured(resolved.status === 'ready' ? resolved : null)
      if (resolved.status !== 'ready') {
        setReason(resolved.reason)
      }
    },
    [entries]
  )

  const resolution = useMemo(
    (): AutomationCreateDestinationResolution =>
      captured ? { status: 'ready', ...captured } : { status: 'choice-required', reason },
    [captured, reason]
  )

  // Async submit checks read live entries through refs; a closed-over owner may already be obsolete.
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const repoTablesRef = useRef(repoTables)
  repoTablesRef.current = repoTables

  const check = useCallback(
    (projectId: string): AutomationCreateDestinationCheck => {
      if (!captured) {
        return { ok: false, notice: ownerNotice(choiceMessage(reason)) }
      }
      const revalidated = revalidateAutomationCreateDestination(captured, entriesRef.current)
      if (revalidated.status === 'stale') {
        return {
          ok: false,
          notice: {
            message: translate(
              'auto.components.automations.createDestination.stale',
              '{host} changed while this form was open. Choose it again before saving.'
            ).replace('{host}', revalidated.entry.label),
            recovery: 'retry',
            severity: 'owner'
          }
        }
      }
      if (revalidated.status !== 'ready') {
        return { ok: false, notice: ownerNotice(choiceMessage(revalidated.reason)) }
      }
      if (automationCreateProjectMismatch(repoTablesRef.current, revalidated, projectId)) {
        return {
          ok: false,
          notice: ownerNotice(
            translate(
              'auto.components.automations.createDestination.projectMismatch',
              'That project is not on {host}. Choose a project on that host, or another host.'
            ).replace('{host}', revalidated.entry.label)
          )
        }
      }
      return { ok: true, destination: revalidated }
    },
    [captured, reason]
  )

  const eligibleProjects = useMemo(
    () =>
      resolution.status === 'ready'
        ? automationCreateEligibleProjects(repoTables, resolution, projects)
        : projects,
    [projects, repoTables, resolution]
  )

  return {
    control: useMemo(
      () => ({ entries, resolution, onSelect, projects: eligibleProjects }),
      [eligibleProjects, entries, onSelect, resolution]
    ),
    check
  }
}
