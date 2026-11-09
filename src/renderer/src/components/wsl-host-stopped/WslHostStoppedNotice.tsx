import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LinuxPenguinIcon } from '@/components/icons/LinuxPenguinIcon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { startWslHostAndReloadProjects } from '@/lib/wsl-host-user-start'

/** "<distro> is stopped" with Start, where a surface would otherwise show a read error. Only the click boots (E9). */
export function WslHostStoppedNotice({
  environmentId,
  distro,
  size = 'xs',
  className,
  onStarted
}: {
  environmentId: string
  distro: string
  size?: 'xs' | 'sm'
  className?: string
  onStarted?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [starting, setStarting] = useState(false)
  const mountedRef = useMountedRef()
  const start = (): void => {
    setStarting(true)
    void startWslHostAndReloadProjects(environmentId).then((started) => {
      if (mountedRef.current) {
        setStarting(false)
      }
      if (started) {
        onStarted?.()
      }
    })
  }
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground',
        className
      )}
      role="status"
      data-wsl-host-stopped-notice={environmentId}
    >
      <LinuxPenguinIcon
        className="mb-1 size-7 text-muted-foreground"
        data-wsl-host-stopped-icon=""
      />
      <span>
        {t('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
          distro
        })}
      </span>
      <Button type="button" size={size} disabled={starting} onClick={start}>
        {starting ? <Loader2 className="animate-spin" /> : null}
        {t('components.native-chat.hostOutage.start', 'Start')}
      </Button>
    </div>
  )
}
