import { useState } from 'react'
import type { CommanderAccount } from '../../../../shared/commander/memory-contract'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'

export function CommanderMemoryGrant({
  account,
  projectId
}: {
  account: CommanderAccount
  projectId: string
}): React.JSX.Element {
  const t = useTranslate()
  const [agentId, setAgentId] = useState('')
  const [type, setType] = useState<'commander' | 'agent'>('agent')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  async function exportGrant(): Promise<void> {
    setBusy(true)
    setStatus('')
    setError('')
    try {
      const grant = await window.api.commanderMemory.exportAgentGrant(account, {
        projectId,
        agentId: agentId.trim(),
        type
      })
      if (grant.saved) {
        setStatus(t('commander.memory.grantSaved', 'Agent access file saved.'))
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('commander.memory.grantFailed', 'Could not export agent access.')
      )
    }
    setBusy(false)
  }
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">
        {t('commander.memory.agentAccess', 'Agent access')}
      </summary>
      <form
        className="space-y-2 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && agentId.trim()) {
            void exportGrant()
          }
        }}
      >
        <p className="text-xs text-muted-foreground">
          {t(
            'commander.memory.grantScope',
            'Export a 15-minute access file for an agent working on this project.'
          )}
        </p>
        <Select value={type} onValueChange={(choice: 'agent' | 'commander') => setType(choice)}>
          <SelectTrigger size="sm" aria-label={t('commander.memory.role', 'Role')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="agent">{t('commander.memory.agent', 'Agent')}</SelectItem>
            <SelectItem value="commander">
              {t('commander.memory.commander', 'Commander')}
            </SelectItem>
          </SelectContent>
        </Select>
        <label className="block space-y-1">
          {t('commander.memory.agentId', 'Agent ID')}
          <Input
            required
            maxLength={128}
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          />
        </label>
        <Button size="xs" variant="outline" type="submit" disabled={busy || !agentId.trim()}>
          {t('commander.memory.exportGrant', 'Export access file')}
        </Button>
        {status && <p role="status">{status}</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </form>
    </details>
  )
}
