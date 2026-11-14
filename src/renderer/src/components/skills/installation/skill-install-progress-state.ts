import { useEffect, useRef, useState } from 'react'
import type { SkillInstallProgress } from '../../../../../shared/skill-sharing-contract'
import { useTranslate } from '@/i18n/use-translate'

export function useSkillInstallProgress(): {
  activeOperationId: string | null
  phaseLabel: string | null
  begin: (operationId: string) => void
  finish: () => void
} {
  const t = useTranslate()
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null)
  const activeOperationIdRef = useRef<string | null>(null)
  const [progress, setProgress] = useState<SkillInstallProgress | null>(null)

  useEffect(
    () =>
      window.api.skills.onInstallProgress((progress) => {
        if (progress.operationId === activeOperationIdRef.current) {
          setProgress(progress)
        }
      }),
    []
  )

  return {
    activeOperationId,
    phaseLabel: progress?.currentSkill
      ? t(
          'auto.components.skills.skill-install-progress-state.currentSkill',
          'Installing {{value0}} of {{value1}}: {{value2}}…',
          {
            value0: progress.currentSkill.index,
            value1: progress.currentSkill.total,
            value2: progress.currentSkill.name
          }
        )
      : progress
        ? progress.phase === 'authorizing'
          ? t('auto.components.skills.install.authorizing', 'Authorizing package access…')
          : t(
              'auto.components.skills.install.installing',
              'Downloading, verifying, and installing…'
            )
        : null,
    begin: (operationId) => {
      activeOperationIdRef.current = operationId
      setActiveOperationId(operationId)
      setProgress({ operationId, phase: 'authorizing' })
    },
    finish: () => {
      activeOperationIdRef.current = null
      setActiveOperationId(null)
      setProgress(null)
    }
  }
}
