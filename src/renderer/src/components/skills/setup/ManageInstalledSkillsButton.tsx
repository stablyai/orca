import { BookOpen } from 'lucide-react'
import { isRuntimeHostContactRevoked } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'
import {
  bundledSkillTargetKey,
  type BundledSkillTarget
} from '@/lib/skills/runtime/bundled-skill-target'
import { Button } from '../../ui/button'

export function ManageInstalledSkillsButton({
  target
}: {
  target?: BundledSkillTarget | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const openSkillsPage = useAppStore((state) => state.openSkillsPage)
  const closeModal = useAppStore((state) => state.closeModal)
  const { bundledSkillTarget: active, managerRuntimeTarget: manager } =
    useActiveProjectSkillRuntime()
  const unavailable = useAppStore((state) => {
    if (active?.kind !== 'environment') {
      return false
    }
    const entry = state.runtimeStatusByEnvironmentId.get(active.environmentId)
    return isRuntimeHostContactRevoked(entry) || entry?.snapshot?.transport === 'disconnected'
  })
  // The existing manager follows the active host; never send another host's card there.
  if (
    unavailable ||
    !active ||
    !manager ||
    active.kind === 'ssh' ||
    bundledSkillTargetKey(manager) !== bundledSkillTargetKey(active) ||
    (target !== undefined &&
      (!target || bundledSkillTargetKey(target) !== bundledSkillTargetKey(active)))
  ) {
    return null
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => {
        closeModal()
        openSkillsPage()
      }}
    >
      <BookOpen className="size-3.5" />
      {t('auto.components.settings.shareSkills.openSkills', 'Open Skills')}
    </Button>
  )
}
