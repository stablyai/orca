import { useEffect, useInsertionEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useSkillFreshness } from '@/hooks/skills/freshness/useSkillFreshness'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'
import { bundledSkillTargetKey } from '@/lib/skills/runtime/bundled-skill-target'
import {
  getBlockingBodyOverlaySnapshot,
  hasBlockingBodyOverlay,
  subscribeBodyOverlayChanges
} from '@/lib/overlay-interaction/body-overlay-attributes'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import {
  bundledSkillNudgeEntries,
  bundledSkillNudgeKey
} from '../../../../../shared/bundled-skill-summary'
import { requestSkillFreshnessUpdateDialog } from './skill-freshness-update-dialog'
import { autoUpdateUnmodifiedSkills } from './skill-freshness-auto-update'

const MAX_DISMISSED_FRESHNESS_NUDGES = 512
const NO_DISMISSED_FRESHNESS_NUDGES: string[] = []

type ActiveFreshnessNudge = {
  id: string | number
  fingerprint: string
  persistDismissal: boolean
  /** Sonner delivers a task after publication; until it first renders, a new hold withholds it. */
  presented: boolean
}

/** Title that reports Sonner's first render of the toast, before that frame paints. */
function NudgeTitle({
  text,
  onFirstPresentation
}: {
  text: string
  onFirstPresentation: (element: HTMLElement | null) => void
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    onFirstPresentation(ref.current)
  }, [onFirstPresentation])
  return <span ref={ref}>{text}</span>
}

export function SkillFreshnessNudge({
  startupPromptsFinished
}: {
  startupPromptsFinished: boolean
}): null {
  const blockingOverlayOpen = useSyncExternalStore(
    subscribeBodyOverlayChanges,
    getBlockingBodyOverlaySnapshot
  )
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
  // Startup gating applies once; a later dialog leaves the toast dimmed behind its backdrop, like other toasts, rather than re-creating it.
  const startupReleasedRef = useRef(false)
  const logicalHoldRef = useRef(!startupPromptsFinished)
  useInsertionEffect(() => {
    logicalHoldRef.current = !startupPromptsFinished
  }, [startupPromptsFinished])

  useEffect(() => {
    // Programmatic retraction is not a user dismissal, so the same nudge may return this session.
    const retract = (active: ActiveFreshnessNudge): void => {
      active.persistDismissal = false
      activeNudgeRef.current = null
      shownFingerprints.current.delete(active.fingerprint)
      toast.dismiss(active.id)
    }
    if (startupPromptsFinished) {
      startupReleasedRef.current = true
    }
    if (!startupReleasedRef.current) {
      const active = activeNudgeRef.current
      if (active) {
        retract(active)
      }
      return
    }
    if (!target || !targetKey) {
      const active = activeNudgeRef.current
      if (active) {
        retract(active)
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
        // Retract authority based on old bytes after a failed recheck without persisting a user dismissal.
        retract(active)
      }
      return
    }
    // Unedited Orca copies update without consent; the nudge names only edited, unknown or broken ones.
    const autoUpdating = autoUpdateUnmodifiedSkills(target, plan)
    // Fingerprint host, counted skills and offered bytes so changed bundles can prompt again.
    const fingerprint = bundledSkillNudgeKey(targetKey, plan, autoUpdating)
    if (!fingerprint || dismissed.includes(fingerprint)) {
      const active = activeNudgeRef.current
      if (active) {
        // Retracting a resolved/replaced nudge is not an explicit user dismissal.
        retract(active)
      }
      return
    }
    const active = activeNudgeRef.current
    if (active?.fingerprint === fingerprint) {
      return
    }
    if (active) {
      retract(active)
    }
    // The startup release only keeps an existing toast; a new one waits for the current hold
    // (a modal still loading has no portal yet). Portals can mount in this commit before the
    // observer publishes their presence. A change to either cancels the pending frame below.
    if (!startupPromptsFinished || blockingOverlayOpen || hasBlockingBodyOverlay()) {
      return
    }
    if (shownFingerprints.current.has(fingerprint)) {
      return
    }
    const show = (): void => {
      // A dialog opened in this same update mounts its portal after this effect; check once it settles.
      if (hasBlockingBodyOverlay()) {
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
      const names = new Set(bundledSkillNudgeEntries(plan, autoUpdating).map((entry) => entry.name))
      // Name outdated skills directly; translate the sentence while interpolating identifiers unchanged.
      const outdatedNames = [...names]
        .sort((left, right) => left.localeCompare(right, 'en'))
        .join(', ')
      const nextActive: ActiveFreshnessNudge = {
        id: '',
        fingerprint,
        persistDismissal: true,
        presented: false
      }
      const presentOrWithhold = (element: HTMLElement | null): void => {
        if (nextActive.presented || activeNudgeRef.current !== nextActive) {
          return
        }
        if (logicalHoldRef.current || hasBlockingBodyOverlay()) {
          // A modal or prompt took over between publication and delivery: never show this copy.
          const toastElement = element?.closest<HTMLElement>('[data-sonner-toast]')
          if (toastElement) {
            toastElement.style.display = 'none'
          }
          retract(nextActive)
          return
        }
        nextActive.presented = true
      }
      const title =
        names.size === 1
          ? translate(
              'auto.components.skills.SkillFreshnessNudge.titleOne',
              'An installed Orca skill is out of date'
            )
          : translate(
              'auto.components.skills.SkillFreshnessNudge.title',
              '{{count}} installed Orca skills are out of date',
              {
                count: names.size,
                defaultValue_one: '{{count}} installed Orca skill is out of date'
              }
            )
      nextActive.id = toast.info(
        <NudgeTitle text={title} onFirstPresentation={presentOrWithhold} />,
        {
          description: translate(
            'auto.components.skills.SkillFreshnessNudge.description',
            'Update {{value0}} so agents follow the current instructions for this version of Orca.',
            { value0: outdatedNames }
          ),
          // Keep the nudge until action; quitting records no dismissal, allowing one prompt next launch.
          duration: Number.POSITIVE_INFINITY,
          // Persist only explicit close-button dismissal; opening review is engagement.
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
                  ? translate(
                      'auto.components.skills.SkillFreshnessNudge.updateOne',
                      'Update skill'
                    )
                  : translate(
                      'auto.components.skills.SkillFreshnessNudge.updateMany',
                      'Update skills'
                    )}
              </span>
            ),
            onClick: () => {
              // Sonner action closure skips onDismiss; clear ownership so later inventory cannot retain a closed toast.
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
    }
    const frame = requestAnimationFrame(show)
    return () => cancelAnimationFrame(frame)
  }, [
    target,
    targetKey,
    blockingOverlayOpen,
    dismissed,
    settingsLoaded,
    startupPromptsFinished,
    state.error,
    state.plan,
    updateSettings
  ])

  return null
}
