import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import type {
  SkillDeletePlan,
  SkillDeleteRequest,
  SkillDeleteResult
} from '../../../../shared/skill-delete-contract'
import type { DiscoveredSkill } from '../../../../shared/skills'
import {
  deleteSkillsOnRuntimeTarget,
  previewSkillDeletionOnRuntimeTarget,
  runtimeTargetSupportsSkillDelete
} from '../../runtime/runtime-skills-client'
import type { RuntimeClientTarget } from '../../runtime/runtime-rpc-client'
import {
  skillDeleteActionLabel,
  skillDeleteBlockedLines,
  skillDeleteNothingToDoLabel,
  skillDeletePlacementSummary,
  skillDeleteRetainedSourceLines
} from './skill-delete-copy'

export type SkillDeleteFlow = {
  /** False while the target is unresolved or the host predates the capability. */
  supported: boolean
  /** Why it is unsupported — the two causes need different copy. Null when
   *  delete is available. */
  unsupportedReason: string | null
  running: boolean
  result: SkillDeleteResult | null
  dismissResult: () => void
  reprobe: () => void
  requestDelete: (skills: readonly DiscoveredSkill[]) => Promise<boolean>
}

function toRequest(skills: readonly DiscoveredSkill[]): SkillDeleteRequest {
  return {
    operationId: crypto.randomUUID(),
    skills: skills.map((skill) => ({
      id: skill.id,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath,
      name: skill.name,
      updatedAt: skill.updatedAt
    }))
  }
}

export function useSkillDeleteFlow(
  runtimeTarget: RuntimeClientTarget | null,
  hostLabel: string | null,
  onDeleted: (result: SkillDeleteResult) => void
): SkillDeleteFlow {
  const confirm = useConfirmationDialog()
  const mountedRef = useMountedRef()
  const [probeGeneration, setProbeGeneration] = useState(0)
  const [capability, setCapability] = useState<
    'checking' | 'supported' | 'unsupported' | 'unavailable'
  >('checking')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SkillDeleteResult | null>(null)

  useEffect(() => {
    let current = true
    setCapability('checking')
    const probe = (attempt: number): void => {
      void runtimeTargetSupportsSkillDelete(runtimeTarget)
        .then((value) => {
          if (current && mountedRef.current) {
            setCapability(value ? 'supported' : 'unsupported')
          }
        })
        .catch(() => {
          if (!current || !mountedRef.current) {
            return
          }
          if (attempt < 2) {
            probe(attempt + 1)
          } else {
            setCapability('unavailable')
          }
        })
    }
    probe(0)
    return () => {
      current = false
    }
  }, [mountedRef, probeGeneration, runtimeTarget])

  const requestDelete = useCallback(
    async (skills: readonly DiscoveredSkill[]): Promise<boolean> => {
      if (!runtimeTarget || skills.length === 0) {
        return false
      }
      const request = toRequest(skills)
      setRunning(true)
      try {
        const plan = await previewSkillDeletionOnRuntimeTarget(runtimeTarget, request)
        const actionable = plan.skills.filter((skill) => !skill.blocked)
        if (actionable.length === 0) {
          // The preview already knows this would remove nothing. Offering a
          // destructive confirm here is what let a blocked row be "deleted"
          // over and over with no effect; say why instead, in the band, where
          // it persists long enough to act on.
          setResult(blockedOnlyResult(plan))
          toast.error(skillDeleteNothingToDoLabel(plan.skills.length))
          return false
        }
        const confirmed = await confirm({
          title: skillDeleteActionLabel(actionable.length),
          description: [
            hostLabel
              ? translate('auto.components.skills.SkillDelete.confirmHost', 'On {{host}}.', {
                  host: hostLabel
                })
              : null,
            skillDeletePlacementSummary(plan),
            // Permanent, so a single-skill delete names the paths themselves.
            actionable.length === 1
              ? actionable.flatMap((skill) => skill.placements.map((p) => p.path)).join('\n')
              : null,
            ...skillDeleteRetainedSourceLines(plan),
            ...skillDeleteBlockedLines(plan),
            translate(
              'auto.components.skills.SkillDelete.confirmPermanent',
              'This cannot be undone.'
            )
          ]
            .filter((line): line is string => Boolean(line))
            .join('\n'),
          confirmLabel: skillDeleteActionLabel(actionable.length),
          confirmVariant: 'destructive'
        })
        if (!confirmed) {
          return false
        }
        const outcome = await deleteSkillsOnRuntimeTarget(runtimeTarget, request)
        if (!mountedRef.current) {
          return true
        }
        const deleted = outcome.skills.filter((skill) => skill.status === 'deleted').length
        if (deleted > 0) {
          toast.success(skillDeletedToast(deleted))
        }
        setResult(outcome)
        onDeleted(outcome)
        return true
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate('auto.components.skills.SkillDelete.failed', 'Could not delete skills')
        )
        return false
      } finally {
        if (mountedRef.current) {
          setRunning(false)
        }
      }
    },
    [confirm, hostLabel, mountedRef, onDeleted, runtimeTarget]
  )

  return {
    supported: capability === 'supported',
    unsupportedReason:
      capability === 'supported' ? null : unsupportedReason(runtimeTarget, capability),
    running,
    result,
    dismissResult: useCallback(() => setResult(null), []),
    reprobe: useCallback(() => setProbeGeneration((generation) => generation + 1), []),
    requestDelete
  }
}

/** Turns a plan in which nothing is actionable into the same result shape the
 *  band already groups, so one component renders every skip reason. */
function blockedOnlyResult(plan: SkillDeletePlan): SkillDeleteResult {
  return {
    operationId: plan.operationId,
    skills: plan.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      status: 'skipped' as const,
      ...(skill.blocked ? { blocked: skill.blocked } : {}),
      removedPaths: []
    }))
  }
}

function unsupportedReason(
  runtimeTarget: RuntimeClientTarget | null,
  capability: 'checking' | 'supported' | 'unsupported' | 'unavailable'
): string {
  // The shared constant is the wire-side error text; what the user reads here
  // goes through the catalog like every other string in this panel.
  if (capability === 'unavailable') {
    return translate(
      'auto.components.skills.SkillDelete.hostUnavailable',
      'Could not reach the selected machine. Refresh and try again.'
    )
  }
  return runtimeTarget
    ? translate(
        'auto.components.skills.SkillDelete.hostUpdateRequired',
        'Update Orca on the selected machine to delete skills.'
      )
    : translate(
        'auto.components.skills.SkillDelete.hostUnresolved',
        'Still finding the machine that owns these skills.'
      )
}

function skillDeletedToast(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.deletedOne', 'Deleted {{count}} skill', { count })
    : translate('auto.components.skills.count.deletedOther', 'Deleted {{count}} skills', { count })
}
