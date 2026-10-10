import { useMemo } from 'react'
import { useAppStore } from '../store'
import type { ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { NativeChatRestartMachineOffer } from './native-chat-resume-on-restart-store'
import { LOCAL_RESTART_MACHINE, type RestartMachineKey } from './native-chat-restart-machines'
import { restartMachineNameFromState } from './native-chat-restart-machine-name'
import { resumeCandidateOwnership } from './native-chat-resume-ownership'
import { restartListingIdentity, type ResumeSelectionMachine } from './native-chat-resume-selection'
import { getNativeChatRestartRuns, type NativeChatRestartRuns } from './native-chat-restart-runs'

export type MachineView = ResumeSelectionMachine & {
  offer: NativeChatRestartMachineOffer
  name: string
}

/** Every machine with offers, plus one whose run outlived its offers, listed as it was then. */
function listedOffers(
  offers: ReadonlyMap<RestartMachineKey, NativeChatRestartMachineOffer>,
  runs: NativeChatRestartRuns
): ReadonlyMap<RestartMachineKey, NativeChatRestartMachineOffer> {
  const listed = new Map(offers)
  for (const [machine, entry] of runs) {
    if (!listed.has(machine)) {
      listed.set(machine, { ...entry.listing, candidates: [], failed: [] })
    }
  }
  return listed
}

/** This computer first, then each paired server by name. */
function orderedOffers(
  offers: ReadonlyMap<RestartMachineKey, NativeChatRestartMachineOffer>,
  nameOf: (machine: RestartMachineKey) => string
): NativeChatRestartMachineOffer[] {
  return [...offers.values()].sort((left, right) =>
    left.machine === LOCAL_RESTART_MACHINE
      ? -1
      : right.machine === LOCAL_RESTART_MACHINE
        ? 1
        : nameOf(left.machine).localeCompare(nameOf(right.machine))
  )
}

/** Each listed machine, ordered, with its name and each chat's ownership as its host judged it.
 *  Names are selected as one joined string so the selector returns a PRIMITIVE and the dialog
 *  re-renders only when a name actually changes. */
export function useMachineViews(
  currentOffers: ReadonlyMap<RestartMachineKey, NativeChatRestartMachineOffer>,
  runs: NativeChatRestartRuns
): MachineView[] {
  // Keyed on which machines have a run, not on each progress frame of one.
  const runMachines = [...runs.keys()].join('\u0000')
  const offers = useMemo(
    () => (runMachines ? listedOffers(currentOffers, getNativeChatRestartRuns()) : currentOffers),
    [currentOffers, runMachines]
  )
  const joined = useAppStore((state) =>
    [...offers.keys()]
      .map((machine) => `${machine}\u0001${restartMachineNameFromState(state, machine)}`)
      .join('\u0002')
  )
  return useMemo(() => {
    const names = new Map(
      joined
        .split('\u0002')
        .filter(Boolean)
        .map((entry) => {
          const [machine = '', name = ''] = entry.split('\u0001')
          return [machine, name] as const
        })
    )
    return orderedOffers(offers, (machine) => names.get(machine) ?? machine).map((offer) => {
      const rows = [...offer.candidates, ...offer.failed]
      const rowById = new Map(rows.map((row) => [row.sessionId, row]))
      const failureById = new Map<string, ResumeFailure>(
        offer.failed.map((failure) => [failure.sessionId, failure])
      )
      return {
        machine: offer.machine,
        identity: restartListingIdentity(offer.machine, offer.fence.pairingRevision),
        offer,
        name: names.get(offer.machine) ?? offer.machine,
        rows,
        failureFor: (sessionId: string) => failureById.get(sessionId),
        ownershipFor: (sessionId: string) => {
          const row = rowById.get(sessionId)
          return row ? resumeCandidateOwnership(row) : 'unknown'
        }
      }
    })
  }, [joined, offers])
}
