import type { BundledSkillPlan } from '../../../shared/bundled-skill-plan'
import { bundledSkillSetupAttentionMessage } from '@/components/settings/bundled-skill-setup-result-copy'
import {
  bundledSkillSetupChanges,
  type BundledSkillSetupChanges
} from '@/components/settings/bundled-skill-setup-copy'
import { useEffect, useState } from 'react'
import {
  bundledSkillInstallAction,
  type BundledSkillInstallAction
} from '../../../shared/bundled-skill-summary'
import { bundledSkillTargetKey, type BundledSkillTarget } from '@/lib/bundled-skill-target'
import {
  planBundledSkillsOnTarget,
  type BundledSkillUnsupportedReason
} from '@/runtime/runtime-bundled-skills-client'
import {
  INSTALLED_AGENT_SKILLS_CHANGED_EVENT,
  INSTALLED_AGENT_SKILLS_REFRESHED_EVENT
} from './installed-agent-skills-change-event'
import { useActiveProjectSkillRuntime } from './useActiveProjectSkillRuntime'
import { useAppStore } from '@/store'
import { getManagedOrcadSshTargetId } from '../../../shared/managed-orcad-execution-host'

/** `unknown`: the owning host's check failed. */
export type BundledSkillInstallActionState =
  | (BundledSkillInstallAction & {
      changes?: BundledSkillSetupChanges
      attentionMessage?: string
      plan?: BundledSkillPlan
    })
  | { kind: 'loading' }
  | { kind: 'unsupported'; reason: BundledSkillUnsupportedReason }
  | { kind: 'unknown' }

const LOADING: BundledSkillInstallActionState = { kind: 'loading' }
const UNKNOWN: BundledSkillInstallActionState = { kind: 'unknown' }

/** What a setup screen's button would do for `skillNames` on the agents' host, from its plan. */
export function useBundledSkillInstallAction(
  skillNames: readonly string[],
  options: { enabled: boolean; refreshKey: string; target?: BundledSkillTarget | null }
): BundledSkillInstallActionState {
  const activeTarget = useActiveProjectSkillRuntime().bundledSkillTarget
  const target = options.target === undefined ? activeTarget : options.target
  const targetKey = target ? bundledSkillTargetKey(target) : null
  const unavailable = useAppStore((state) => {
    if (target?.kind !== 'environment') {
      return null
    }
    const snapshot = state.runtimeStatusByEnvironmentId.get(target.environmentId)?.snapshot
    if (!snapshot?.retired && snapshot?.transport !== 'disconnected') {
      return null
    }
    const environment = state.runtimeEnvironments.find((entry) => entry.id === target.environmentId)
    return environment && getManagedOrcadSshTargetId(environment) ? 'connect-host' : 'unknown'
  })
  const namesKey = skillNames.join(',')
  const planKey = options.enabled && targetKey && !unavailable ? `${targetKey}|${namesKey}` : null
  const [answer, setAnswer] = useState<{ key: string; action: BundledSkillInstallActionState }>()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const onChanged = (): void => setRevision((value) => value + 1)
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, onChanged)
    window.addEventListener(INSTALLED_AGENT_SKILLS_REFRESHED_EVENT, onChanged)
    return () => {
      window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, onChanged)
      window.removeEventListener(INSTALLED_AGENT_SKILLS_REFRESHED_EVENT, onChanged)
    }
  }, [])

  useEffect(() => {
    if (!planKey || !target) {
      setAnswer(undefined)
      return
    }
    let ignore = false
    void (async () => {
      try {
        const request = { names: namesKey.split(',') }
        const planned = await planBundledSkillsOnTarget(target, request)
        const action: BundledSkillInstallActionState =
          planned.kind === 'plan'
            ? {
                ...bundledSkillInstallAction(planned.plan),
                plan: planned.plan,
                changes: bundledSkillSetupChanges(planned.plan),
                attentionMessage: bundledSkillSetupAttentionMessage(planned.plan)
              }
            : planned
        if (!ignore) {
          setAnswer({ key: planKey, action })
        }
      } catch {
        if (!ignore) {
          setAnswer({ key: planKey, action: UNKNOWN })
        }
      }
    })()
    return () => {
      ignore = true
    }
  }, [planKey, namesKey, options.refreshKey, revision, target])

  if (unavailable) {
    return unavailable === 'connect-host'
      ? { kind: 'unsupported', reason: 'connect-host' }
      : UNKNOWN
  }
  return planKey && answer?.key === planKey ? answer.action : LOADING
}
