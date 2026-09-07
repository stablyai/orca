import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  isSkillWarningPreviewEnabled,
  SKILL_WARNING_PREVIEW_SHARE_ID
} from './skill-warning-preview-gate'

export function SkillWarningPreviewLauncher(): null {
  const persistedUIReady = useAppStore((state) => state.persistedUIReady)

  useEffect(() => {
    if (persistedUIReady && isSkillWarningPreviewEnabled()) {
      useAppStore.getState().openSkillShare(SKILL_WARNING_PREVIEW_SHARE_ID)
    }
  }, [persistedUIReady])

  return null
}
