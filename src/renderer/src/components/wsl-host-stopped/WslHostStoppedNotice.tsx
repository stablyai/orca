import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LinuxPenguinIcon } from '@/components/icons/LinuxPenguinIcon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { startWslHostAndReloadProjects } from '@/runtime/hosts/wsl/wsl-host-user-start'

/**
 * "<distro> is stopped" with Start, where a surface would otherwise show a read error. Only the click
 * boots (E9). `connecting` swaps in "Connecting to <distro>…" while it boots, so the stale error never shows.
 */
export function WslHostStoppedNotice({
  environmentId,
  distro,
  connecting = false,
  size = 'xs',
  className,
  onStarted
}: {
  environmentId: string
  distro: string
  connecting?: boolean
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
      {connecting ? (
        <span className="flex items-center gap-1.5" data-wsl-host-connecting="">
          <Loader2 className="size-3.5 animate-spin" />
          {t('components.native-chat.hostOutage.connecting', 'Connecting to {{distro}}…', {
            distro
          })}
        </span>
      ) : (
        <>
          <span>
            {t('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
              distro
            })}
          </span>
          <Button type="button" size={size} disabled={starting} onClick={start}>
            {starting ? <Loader2 className="animate-spin" /> : null}
            {t('components.native-chat.hostOutage.start', 'Start')}
          </Button>
        </>
      )}
    </div>
  )
}
