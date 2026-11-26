import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { CommanderAccount } from '../../../../shared/commander/memory-contract'

export function CommanderPhoneSharing({
  account
}: {
  account: CommanderAccount
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(true)
  const [failed, setFailed] = useState(false)
  const requests = useRef(0)
  const update = useCallback(
    async (value?: boolean) => {
      const sequence = ++requests.current
      setPending(true)
      try {
        const result = await window.api.commanderMemory.phoneSharing(account, value)
        if (sequence === requests.current) {
          setEnabled(result)
          setFailed(false)
        }
      } catch {
        if (sequence === requests.current) {
          setFailed(true)
        }
      }
      if (sequence === requests.current) {
        setPending(false)
      }
    },
    [account]
  )
  useEffect(() => {
    void update()
  }, [update])
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium" htmlFor={id}>
            {t('commander.memory.phoneSharing', 'Share Memory with paired phones')}
          </label>
          <p id={`${id}-detail`} className="text-xs text-muted-foreground">
            {t(
              'commander.memory.phoneSharingDetail',
              'Phones paired to this desktop can read and edit memory for your current account and organization.'
            )}
          </p>
        </div>
        <Switch
          id={id}
          aria-describedby={`${id}-detail`}
          disabled={pending || failed}
          checked={enabled}
          onCheckedChange={(value) => void update(value)}
        />
      </div>
      {failed && (
        <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
          {t('commander.memory.phoneSharingError', 'Could not check phone sharing.')}
          <Button variant="ghost" size="xs" disabled={pending} onClick={() => void update()}>
            {t('commander.memory.retry', 'Retry')}
          </Button>
        </div>
      )}
    </div>
  )
}
