/**
 * The create dialog's destination: chosen once, shown, and re-checked at submit.
 *
 * The captured destination is deliberately state rather than a derivation of the
 * live catalog. A dialog keeps the owner it captured for its whole lifetime, so
 * a host that re-pairs or re-registers while the form is open is reported as
 * moved instead of silently followed — which is the only way the user's "create
 * it on that machine" survives the machine changing identity underneath it.
 */

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
    'Choose the host this automation will be created on.'
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

  // Adjusted during render rather than in an effect, so no frame paints the
  // previous dialog's capture. Each branch is guarded on an actual change, so
  // the re-render this schedules converges immediately.
  if (!open && (captured !== null || reason !== 'unselected')) {
    setCaptured(null)
    setReason('unselected')
  }
  if (open && !captured) {
    // Re-resolves until it first captures: a catalog still hydrating must not lock
    // the form into "choose a host" once the host it would have picked arrives.
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

  // Why refs: the check runs inside an async submit, where a value closed over
  // when the handler was created could be an incarnation old.
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
