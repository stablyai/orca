import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { requestSkillFreshnessUpdateDialog } from './skill-freshness-update-dialog'

const MAX_DISMISSED_FRESHNESS_NUDGES = 512
const NO_DISMISSED_FRESHNESS_NUDGES: string[] = []

type ActiveFreshnessNudge = {
  id: string | number
  fingerprint: string
  persistDismissal: boolean
}

function candidateKey(args: {
  physicalIdentity: string
  name: string
  currentReleaseRevision: number
}): string {
  return [args.physicalIdentity, args.name, args.currentReleaseRevision].join('\0')
}

export function SkillFreshnessNudge(): null {
  const state = useSkillFreshness()
  const settingsLoaded = useAppStore((store) => store.settings !== null)
  const dismissed = useAppStore(
    (store) => store.settings?.dismissedSkillFreshnessNudges ?? NO_DISMISSED_FRESHNESS_NUDGES
  )
  const updateSettings = useAppStore((store) => store.updateSettings)
  const shownFingerprints = useRef(new Set<string>())
  const persistedFingerprints = useRef(new Set<string>())
  const activeNudgeRef = useRef<ActiveFreshnessNudge | null>(null)

  useEffect(() => {
    const inventory = state.inventory
    if (!settingsLoaded) {
      return
    }
    if (!inventory) {
      const active = activeNudgeRef.current
      if (state.error && active) {
        // Why: a failed re-check cannot keep advertising authority derived from
        // old bytes; retract without turning the scan failure into a dismissal.
        active.persistDismissal = false
        activeNudgeRef.current = null
        toast.dismiss(active.id)
      }
      return
    }
    const eligibleNames = new Set(inventory.eligibleUpdateNames)
    const candidates = inventory.installations.flatMap((installation) =>
      installation.status === 'outdated' &&
      eligibleNames.has(installation.name) &&
      installation.physicalIdentity
        ? [
            {
              key: candidateKey({
                physicalIdentity: installation.physicalIdentity,
                name: installation.name,
                currentReleaseRevision: installation.currentReleaseRevision
              }),
              name: installation.name
            }
          ]
        : []
    )
    const dismissedKeys = new Set(dismissed)
    const unseen = candidates.filter((candidate) => !dismissedKeys.has(candidate.key))
    if (unseen.length === 0) {
      const active = activeNudgeRef.current
      if (active) {
        // Why: a resolved/replaced nudge is stale presentation, not an explicit
        // user dismissal, so retract it without persisting its tuple keys.
        active.persistDismissal = false
        activeNudgeRef.current = null
        toast.dismiss(active.id)
      }
      return
    }
    const fingerprint = unseen
      .map((candidate) => candidate.key)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .join('\n')
    const active = activeNudgeRef.current
    if (active?.fingerprint === fingerprint) {
      return
    }
    if (active) {
      active.persistDismissal = false
      activeNudgeRef.current = null
      toast.dismiss(active.id)
    }
    if (shownFingerprints.current.has(fingerprint)) {
      return
    }
    shownFingerprints.current.add(fingerprint)

    const persistDismissal = (): void => {
      if (persistedFingerprints.current.has(fingerprint)) {
        return
      }
      persistedFingerprints.current.add(fingerprint)
      const current = useAppStore.getState().settings?.dismissedSkillFreshnessNudges ?? []
      const next = [...new Set([...current, ...unseen.map((candidate) => candidate.key)])].slice(
        -MAX_DISMISSED_FRESHNESS_NUDGES
      )
      void updateSettings({ dismissedSkillFreshnessNudges: next }).catch(() => {
        persistedFingerprints.current.delete(fingerprint)
      })
    }
    const names = new Set(unseen.map((candidate) => candidate.name))
    // Why: name the outdated skills so the nudge is actionable without opening
    // the modal; the sentence is translatable but the identifiers interpolate as-is.
    const outdatedNames = [...names]
      .sort((left, right) => left.localeCompare(right, 'en'))
      .join(', ')
    const nextActive: ActiveFreshnessNudge = {
      id: '',
      fingerprint,
      persistDismissal: true
    }
    nextActive.id = toast.info(
      names.size === 1
        ? translate(
            'auto.components.skills.SkillFreshnessNudge.titleOne',
            'An installed Orca skill is out of date'
          )
        : translate(
            'auto.components.skills.SkillFreshnessNudge.titleMany',
            '{{value0}} installed Orca skills are out of date',
            { value0: names.size }
          ),
      {
        description: translate(
          'auto.components.skills.SkillFreshnessNudge.description',
          'Update {{value0}} so agents follow the current instructions for this version of Orca.',
          { value0: outdatedNames }
        ),
        // Why: the nudge lingers until the user acts. Ignoring it (app quit)
        // records nothing, so a still-outdated skill may prompt once next launch.
        duration: Number.POSITIVE_INFINITY,
        // Why: only an explicit dismissal (the close button) records the keys;
        // opening the review dialog is engagement, not a decision to hide it.
        onDismiss: () => {
          if (nextActive.persistDismissal) {
            persistDismissal()
          }
          if (activeNudgeRef.current === nextActive) {
            activeNudgeRef.current = null
          }
        },
        action: {
          label: (
            <span className="inline-flex items-center gap-1.5">
              <Terminal className="size-3.5" />
              {names.size === 1
                ? translate('auto.components.skills.SkillFreshnessNudge.updateOne', 'Update skill')
                : translate(
                    'auto.components.skills.SkillFreshnessNudge.updateMany',
                    'Update skills'
                  )}
            </span>
          ),
          onClick: () => {
            // Sonner closes action toasts without onDismiss; clear ownership so
            // a later inventory cannot treat the already-closed toast as active.
            nextActive.persistDismissal = false
            if (activeNudgeRef.current === nextActive) {
              activeNudgeRef.current = null
            }
            requestSkillFreshnessUpdateDialog()
          }
        }
      }
    )
    activeNudgeRef.current = nextActive
  }, [dismissed, settingsLoaded, state.error, state.inventory, updateSettings])

  return null
}
