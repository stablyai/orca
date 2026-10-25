import { useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { bundledSkillTargetKey } from '@/lib/bundled-skill-target'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  bundledSkillNudgeKey,
  summarizeBundledSkillPlan
} from '../../../../shared/bundled-skill-summary'
import { requestSkillFreshnessUpdateDialog } from './skill-freshness-update-dialog'

const MAX_DISMISSED_FRESHNESS_NUDGES = 512
const NO_DISMISSED_FRESHNESS_NUDGES: string[] = []

type ActiveFreshnessNudge = {
  id: string | number
  fingerprint: string
  persistDismissal: boolean
}

export function SkillFreshnessNudge(): null {
  const target = useActiveProjectSkillRuntime().bundledSkillTarget
  const targetKey = target ? bundledSkillTargetKey(target) : null
  const state = useSkillFreshness(target)
  const settingsLoaded = useAppStore((store) => store.settings !== null)
  const dismissed = useAppStore(
    (store) => store.settings?.dismissedSkillFreshnessNudges ?? NO_DISMISSED_FRESHNESS_NUDGES
  )
  const updateSettings = useAppStore((store) => store.updateSettings)
  const shownFingerprints = useRef(new Set<string>())
  const persistedFingerprints = useRef(new Set<string>())
  const activeNudgeRef = useRef<ActiveFreshnessNudge | null>(null)

  useEffect(() => {
    if (!targetKey) {
      const active = activeNudgeRef.current
      if (active) {
        active.persistDismissal = false
        activeNudgeRef.current = null
        toast.dismiss(active.id)
      }
      return
    }
    const plan = state.plan
    if (!settingsLoaded) {
      return
    }
    if (!plan) {
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
    // Why the summary's key: it changes with the host, the skills the badge counts and the
    // bytes they would get, so the next Orca version nudges again.
    const fingerprint = bundledSkillNudgeKey(targetKey, plan)
    if (!fingerprint || dismissed.includes(fingerprint)) {
      const active = activeNudgeRef.current
      if (active) {
        // Why: a resolved/replaced nudge is stale presentation, not an explicit
        // user dismissal, so retract it without persisting its key.
        active.persistDismissal = false
        activeNudgeRef.current = null
        toast.dismiss(active.id)
      }
      return
    }
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
      const next = [...new Set([...current, fingerprint])].slice(-MAX_DISMISSED_FRESHNESS_NUDGES)
      void updateSettings({ dismissedSkillFreshnessNudges: next }).catch(() => {
        persistedFingerprints.current.delete(fingerprint)
      })
    }
    const names = new Set(
      summarizeBundledSkillPlan(plan)
        .skills.filter((skill) => skill.state === 'update' || skill.state === 'repair')
        .map((skill) => skill.name)
    )
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
              <RefreshCw className="size-3.5" />
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
  }, [targetKey, dismissed, settingsLoaded, state.error, state.plan, updateSettings])

  return null
}
