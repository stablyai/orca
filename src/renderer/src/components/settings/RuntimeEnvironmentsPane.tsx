import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import type { SettingsSearchEntry } from './settings-search'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

const LOCAL_RUNTIME_VALUE = '__local__'

export const RUNTIME_ENVIRONMENTS_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Active Server',
  description: 'Choose local desktop or a saved remote Orca server.',
  keywords: [
    'runtime',
    'environment',
    'server',
    'client',
    'remote',
    'pairing',
    'cloud',
    'vm',
    'dev box'
  ]
}

type RuntimeEnvironmentsPaneProps = {
  settings: GlobalSettings
  switchRuntimeEnvironment: (environmentId: string | null) => Promise<boolean>
}

export function RuntimeEnvironmentsPane({
  settings,
  switchRuntimeEnvironment
}: RuntimeEnvironmentsPaneProps): React.JSX.Element {
  const [environments, setEnvironments] = useState<PublicKnownRuntimeEnvironment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [switchingValue, setSwitchingValue] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [pendingSwitchValue, setPendingSwitchValue] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<PublicKnownRuntimeEnvironment | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const activeValue = settings.activeRuntimeEnvironmentId ?? LOCAL_RUNTIME_VALUE
  const isBusy = isSaving || switchingValue !== null || removingId !== null
  const removingActiveServer = pendingRemove?.id === settings.activeRuntimeEnvironmentId

  const loadEnvironments = async (): Promise<void> => {
    setIsLoading(true)
    try {
      setEnvironments(await window.api.runtimeEnvironments.list())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load runtime environments.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadEnvironments()
  }, [])

  const addEnvironment = async (): Promise<void> => {
    const trimmedName = name.trim()
    const trimmedPairingCode = pairingCode.trim()
    if (!trimmedName || !trimmedPairingCode) {
      toast.error('Name and pairing code are required.')
      return
    }
    const duplicate = environments.find(
      (environment) => environment.name.trim().toLowerCase() === trimmedName.toLowerCase()
    )
    if (duplicate) {
      toast.error(`A server named "${duplicate.name}" already exists.`)
      return
    }
    setIsSaving(true)
    try {
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name: trimmedName,
        pairingCode: trimmedPairingCode
      })
      setName('')
      setPairingCode('')
      await loadEnvironments()
      toast.success(`Saved ${result.environment.name}. Use Active Server to switch when ready.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save runtime environment.')
    } finally {
      setIsSaving(false)
    }
  }

  const removeEnvironment = async (
    environment: PublicKnownRuntimeEnvironment
  ): Promise<boolean> => {
    setRemovingId(environment.id)
    setRemoveError(null)
    try {
      if (settings.activeRuntimeEnvironmentId === environment.id) {
        const switched = await switchRuntimeEnvironment(null)
        if (!switched) {
          setRemoveError('Could not switch to Local desktop. Fix the issue and try again.')
          return false
        }
      }
      await window.api.runtimeEnvironments.remove({ selector: environment.id })
      await loadEnvironments()
      toast.success(`Removed ${environment.name}.`)
      return true
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to remove runtime environment.'
      setRemoveError(message)
      toast.error(message)
      return false
    } finally {
      setRemovingId(null)
    }
  }

  const switchToValue = async (value: string): Promise<boolean> => {
    setSwitchingValue(value)
    setSwitchError(null)
    try {
      const switched = await switchRuntimeEnvironment(value === LOCAL_RUNTIME_VALUE ? null : value)
      if (switched) {
        toast.success(`Switched to ${getEnvironmentLabel(value)}.`)
        return true
      }
      setSwitchError('Could not switch servers. Fix the issue and try again.')
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch servers.'
      setSwitchError(message)
      toast.error(message)
      return false
    } finally {
      setSwitchingValue(null)
    }
  }

  const getEnvironmentLabel = (value: string): string => {
    if (value === LOCAL_RUNTIME_VALUE) {
      return 'Local desktop'
    }
    return environments.find((environment) => environment.id === value)?.name ?? 'remote server'
  }

  return (
    <SearchableSetting
      title={RUNTIME_ENVIRONMENTS_SEARCH_ENTRY.title}
      description={RUNTIME_ENVIRONMENTS_SEARCH_ENTRY.description}
      keywords={RUNTIME_ENVIRONMENTS_SEARCH_ENTRY.keywords}
      className="space-y-4 px-1 py-2"
    >
      <div className="space-y-2">
        <div className="space-y-1">
          <Label id="runtime-active-server-label">Active Server</Label>
          <p className="text-xs text-muted-foreground">
            Local keeps today&apos;s desktop behavior. Saved servers route supported client calls
            through the remote runtime.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={activeValue}
            onValueChange={(value) => {
              if (value !== activeValue) {
                setSwitchError(null)
                setPendingSwitchValue(value)
              }
            }}
            disabled={isBusy}
          >
            <SelectTrigger
              size="sm"
              className="min-w-[260px]"
              aria-labelledby="runtime-active-server-label"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={LOCAL_RUNTIME_VALUE}>Local desktop</SelectItem>
              {environments.map((environment) => (
                <SelectItem key={environment.id} value={environment.id}>
                  {environment.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void loadEnvironments()}
            disabled={isLoading || isBusy}
          >
            {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto]">
        <div className="space-y-1">
          <Label htmlFor="runtime-server-name">Server name</Label>
          <Input
            id="runtime-server-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Dev box"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="runtime-server-pairing-code">Pairing code</Label>
          <Input
            id="runtime-server-pairing-code"
            aria-describedby="runtime-server-pairing-code-help"
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            placeholder="orca://pair#..."
            className="h-8 min-w-0 font-mono text-xs"
          />
          <p id="runtime-server-pairing-code-help" className="text-xs text-muted-foreground">
            Run <span className="font-mono">orca serve --pairing-address &lt;host&gt;</span> on the
            server and paste the printed pairing URL.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="mt-5 gap-1.5"
          onClick={() => void addEnvironment()}
          disabled={isBusy || !name.trim() || !pairingCode.trim()}
        >
          {isSaving ? <Loader2 className="animate-spin" /> : <Plus />}
          Add
        </Button>
      </div>

      <div className="rounded-lg border border-border/50">
        {environments.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">No saved servers.</div>
        ) : (
          <div className="divide-y divide-border/50">
            {environments.map((environment) => (
              <div
                key={environment.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{environment.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {environment.endpoints[0]?.endpoint ?? 'No endpoint'}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    setRemoveError(null)
                    setPendingRemove(environment)
                  }}
                  disabled={isBusy}
                  aria-label={`Remove ${environment.name}`}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={pendingSwitchValue !== null}
        onOpenChange={(open) => {
          if (!open && switchingValue === null) {
            setSwitchError(null)
            setPendingSwitchValue(null)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">Switch Server</DialogTitle>
            <DialogDescription>
              Orca will close remote terminals and browser tabs from the current server before
              loading projects from the next server.
            </DialogDescription>
          </DialogHeader>
          {pendingSwitchValue ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="text-muted-foreground">Switch to</div>
              <div className="mt-0.5 truncate font-medium">
                {getEnvironmentLabel(pendingSwitchValue)}
              </div>
            </div>
          ) : null}
          {switchError ? <p className="text-sm text-destructive">{switchError}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSwitchError(null)
                setPendingSwitchValue(null)
              }}
              disabled={switchingValue !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const value = pendingSwitchValue
                if (!value) {
                  return
                }
                void switchToValue(value).then((switched) => {
                  if (switched) {
                    setPendingSwitchValue(null)
                  }
                })
              }}
              disabled={switchingValue !== null}
            >
              {switchingValue !== null ? <Loader2 className="animate-spin" /> : null}
              Switch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open && removingId === null) {
            setRemoveError(null)
            setPendingRemove(null)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">Remove Server</DialogTitle>
            <DialogDescription>
              {removingActiveServer
                ? 'Removing the active server first switches Orca back to Local desktop and closes remote terminals and browser tabs for that server.'
                : 'This removes the saved server from Orca. It does not change the active server.'}
            </DialogDescription>
          </DialogHeader>
          {pendingRemove ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="truncate font-medium">{pendingRemove.name}</div>
              <div className="mt-0.5 truncate font-mono text-muted-foreground">
                {pendingRemove.endpoints[0]?.endpoint ?? 'No endpoint'}
              </div>
            </div>
          ) : null}
          {removeError ? <p className="text-sm text-destructive">{removeError}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRemoveError(null)
                setPendingRemove(null)
              }}
              disabled={removingId !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const environment = pendingRemove
                if (!environment) {
                  return
                }
                void removeEnvironment(environment).then((removed) => {
                  if (removed) {
                    setPendingRemove(null)
                  }
                })
              }}
              disabled={removingId !== null}
            >
              {removingId !== null ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SearchableSetting>
  )
}
