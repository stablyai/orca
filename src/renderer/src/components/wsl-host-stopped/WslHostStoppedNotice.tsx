import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
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
      <span>
        {translate('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
          distro
        })}
      </span>
      <Button type="button" size={size} disabled={starting} onClick={start}>
        {starting ? <Loader2 className="animate-spin" /> : null}
        {translate('components.native-chat.hostOutage.start', 'Start')}
      </Button>
    </div>
  )
}
