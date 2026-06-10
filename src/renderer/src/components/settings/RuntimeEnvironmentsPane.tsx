/* eslint-disable max-lines -- Why: the server settings pane keeps active
   server selection, saved server mutation, and confirmation dialogs together so
   the state transitions stay auditable. */
import { Loader2, Plus, RefreshCw, Share2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { GlobalSettings } from '../../../../shared/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import {
  getRuntimeEnvironmentsSearchEntry,
  getWebRuntimeEnvironmentsSearchEntry
} from './runtime-environments-search'
import { translate } from '@/i18n/i18n'

const LOCAL_RUNTIME_VALUE = '__local__'
const NO_RUNTIME_VALUE = '__none__'

type RuntimeEnvironmentsPaneProps = {
  settings: GlobalSettings
  switchRuntimeEnvironment: (environmentId: string | null) => Promise<boolean>
  canGeneratePairingUrl?: boolean
  allowLocalRuntime?: boolean
}

export function RuntimeEnvironmentsPane({
  settings,
  switchRuntimeEnvironment,
  canGeneratePairingUrl = true,
  allowLocalRuntime = true
}: RuntimeEnvironmentsPaneProps): React.JSX.Element {
  const [environments, setEnvironments] = useState<PublicKnownRuntimeEnvironment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [switchingValue, setSwitchingValue] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [pendingSwitchValue, setPendingSwitchValue] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<PublicKnownRuntimeEnvironment | null>(null)
  const [addServerFormOpen, setAddServerFormOpen] = useState(false)
  const [shareServerFormOpen, setShareServerFormOpen] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const mountedRef = useMountedRef()
  const activeValue =
    settings.activeRuntimeEnvironmentId ??
    (allowLocalRuntime ? LOCAL_RUNTIME_VALUE : NO_RUNTIME_VALUE)
  const isBusy = isSaving || switchingValue !== null || removingId !== null
  const removingActiveServer = pendingRemove?.id === settings.activeRuntimeEnvironmentId
  const searchEntry = canGeneratePairingUrl
    ? getRuntimeEnvironmentsSearchEntry()
    : getWebRuntimeEnvironmentsSearchEntry()

  const loadEnvironments = useCallback(async (): Promise<void> => {
    if (mountedRef.current) {
      setIsLoading(true)
    }
    try {
      const nextEnvironments = await window.api.runtimeEnvironments.list()
      if (mountedRef.current) {
        setEnvironments(nextEnvironments)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.RuntimeEnvironmentsPane.e6410d72c3',
                'Failed to load runtime environments.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void loadEnvironments()
  }, [loadEnvironments])

  const closeAddServerForm = (): void => {
    if (isSaving) {
      return
    }
    setAddServerFormOpen(false)
    setName('')
    setPairingCode('')
  }

  const addEnvironment = async (): Promise<void> => {
    const trimmedName = name.trim()
    const trimmedPairingCode = pairingCode.trim()
    if (!trimmedName || !trimmedPairingCode) {
      toast.error(
        translate(
          'auto.components.settings.RuntimeEnvironmentsPane.0c55a47480',
          'Name and pairing code are required.'
        )
      )
      return
    }
    const duplicate = environments.find(
      (environment) => environment.name.trim().toLowerCase() === trimmedName.toLowerCase()
    )
    if (duplicate) {
      toast.error(
        translate(
          'auto.components.settings.RuntimeEnvironmentsPane.5ef712f407',
          'A server named "{{value0}}" already exists.',
          { value0: duplicate.name }
        )
      )
      return
    }
    setIsSaving(true)
    try {
      if (!allowLocalRuntime && settings.activeRuntimeEnvironmentId) {
        const disconnected = await switchRuntimeEnvironment(null)
        if (!disconnected) {
          return
        }
      }
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name: trimmedName,
        pairingCode: trimmedPairingCode
      })
      if (mountedRef.current) {
        setName('')
        setPairingCode('')
      }
      await loadEnvironments()
      if (!allowLocalRuntime) {
        const switched = await switchRuntimeEnvironment(result.environment.id)
        if (!switched) {
          await window.api.runtimeEnvironments.remove({ selector: result.environment.id })
          await loadEnvironments()
          return
        }
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.a5b58465b6',
              'Connected to {{value0}}.',
              { value0: result.environment.name }
            )
          )
        }
      } else {
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.7b5986c8df',
              'Saved {{value0}}. Use Active Server to switch when ready.',
              { value0: result.environment.name }
            )
          )
        }
      }
      if (mountedRef.current) {
        setAddServerFormOpen(false)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.RuntimeEnvironmentsPane.6cb6eae14f',
                'Failed to save runtime environment.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false)
      }
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
          if (mountedRef.current) {
            setRemoveError(
              allowLocalRuntime
                ? 'Could not switch to Local desktop. Fix the issue and try again.'
                : 'Could not disconnect from this server. Fix the issue and try again.'
            )
          }
          return false
        }
        if (!allowLocalRuntime) {
          await loadEnvironments()
          if (mountedRef.current) {
            toast.success(
              translate(
                'auto.components.settings.RuntimeEnvironmentsPane.b5b5114cb0',
                'Removed {{value0}}.',
                { value0: environment.name }
              )
            )
          }
          return true
        }
      }
      await window.api.runtimeEnvironments.remove({ selector: environment.id })
      await loadEnvironments()
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.RuntimeEnvironmentsPane.b5b5114cb0',
            'Removed {{value0}}.',
            { value0: environment.name }
          )
        )
      }
      return true
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to remove runtime environment.'
      if (mountedRef.current) {
        setRemoveError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setRemovingId(null)
      }
    }
  }

  const switchToValue = async (value: string): Promise<boolean> => {
    if (value === NO_RUNTIME_VALUE) {
      return false
    }
    setSwitchingValue(value)
    setSwitchError(null)
    try {
      const switched = await switchRuntimeEnvironment(
        allowLocalRuntime && value === LOCAL_RUNTIME_VALUE ? null : value
      )
      if (switched) {
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.99ac81fb43',
              'Switched to {{value0}}.',
              { value0: getEnvironmentLabel(value) }
            )
          )
        }
        return true
      }
      if (mountedRef.current) {
        setSwitchError('Could not switch servers. Fix the issue and try again.')
      }
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch servers.'
      if (mountedRef.current) {
        setSwitchError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setSwitchingValue(null)
      }
    }
  }

  const getEnvironmentLabel = (value: string): string => {
    if (value === LOCAL_RUNTIME_VALUE) {
      return 'Local desktop'
    }
    if (value === NO_RUNTIME_VALUE) {
      return 'No server connected'
    }
    return environments.find((environment) => environment.id === value)?.name ?? 'remote server'
  }

  return (
    <SearchableSetting
      title={searchEntry.title}
      description={searchEntry.description}
      keywords={searchEntry.keywords}
      className="space-y-4 py-2"
    >
      <div className="space-y-2">
        <div className="space-y-1">
          <Label id="runtime-active-server-label">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.64b6bea541',
              'Active Server'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {allowLocalRuntime
              ? translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.f75ce1c7a5',
                  "Local keeps today's desktop behavior. Saved servers route supported client calls through the remote runtime."
                )
              : translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.8cf8790697',
                  'Saved servers route this browser through a paired Orca runtime.'
                )}
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
              {allowLocalRuntime ? (
                <SelectItem value={LOCAL_RUNTIME_VALUE}>
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.78692becbd',
                    'Local desktop'
                  )}
                </SelectItem>
              ) : environments.length === 0 ? (
                <SelectItem value={NO_RUNTIME_VALUE} disabled>
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.b07070ed3c',
                    'No server connected'
                  )}
                </SelectItem>
              ) : null}
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
            size="icon-sm"
            aria-label={translate(
              'auto.components.settings.RuntimeEnvironmentsPane.6ce4664003',
              'Refresh servers'
            )}
            title={translate(
              'auto.components.settings.RuntimeEnvironmentsPane.6ce4664003',
              'Refresh servers'
            )}
            onClick={() => void loadEnvironments()}
            disabled={isLoading || isBusy}
          >
            {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.1826bd0608',
              'Saved Servers'
            )}
          </div>
          {addServerFormOpen ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setAddServerFormOpen(true)}
              disabled={isBusy}
            >
              <Plus />
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.9bee6bbeeb',
                'Add Server'
              )}
            </Button>
          )}
        </div>

        {addServerFormOpen ? (
          <form
            className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void addEnvironment()
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
              <div className="space-y-1">
                <Label htmlFor="runtime-server-name">
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.54ebacc600',
                    'Server name'
                  )}
                </Label>
                <Input
                  id="runtime-server-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.e038625857',
                    'Dev box'
                  )}
                  className="h-8 text-xs"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="runtime-server-pairing-code">
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.9bc9b83474',
                    'Pairing code'
                  )}
                </Label>
                <Input
                  id="runtime-server-pairing-code"
                  aria-describedby="runtime-server-pairing-code-help"
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.c3d772c514',
                    'orca://pair?code=...'
                  )}
                  className="h-8 min-w-0 font-mono text-xs"
                />
                <p id="runtime-server-pairing-code-help" className="text-xs text-muted-foreground">
                  {translate('auto.components.settings.RuntimeEnvironmentsPane.163671f7b5', 'Run')}
                  <span className="font-mono">
                    {translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.960e901ae4',
                      'orca serve --pairing-address <host>'
                    )}
                  </span>{' '}
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.55fcc964cd',
                    'on the server and paste the printed pairing URL.'
                  )}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={closeAddServerForm}
                disabled={isSaving}
              >
                {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={isBusy || !name.trim() || !pairingCode.trim()}
              >
                {isSaving ? <Loader2 className="animate-spin" /> : <Plus />}
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.9bee6bbeeb',
                  'Add Server'
                )}
              </Button>
            </div>
          </form>
        ) : null}

        <div className="rounded-lg border border-border/50">
          {environments.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.9a3758d983',
                'No saved servers.'
              )}
            </div>
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
                      {environment.endpoints[0]?.endpoint ??
                        translate(
                          'auto.components.settings.RuntimeEnvironmentsPane.6ef71985da',
                          'No endpoint'
                        )}
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
                    aria-label={translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.aeb26635d2',
                      'Remove {{value0}}',
                      { value0: environment.name }
                    )}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {canGeneratePairingUrl ? (
        <div className="overflow-hidden rounded-lg border border-border/50">
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium">
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.6e1280ca55',
                  'Share this Orca server'
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.84b9b2be05',
                  'Create a revocable access grant so a browser or another Orca client can connect.'
                )}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setShareServerFormOpen((open) => !open)}
            >
              <Share2 />
              {shareServerFormOpen
                ? translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.54dee18f5c',
                    'Hide Form'
                  )
                : translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.3595fd1948',
                    'New Link'
                  )}
            </Button>
          </div>
          <div className="border-t border-border/40 px-3 py-3">
            <RuntimePairingUrlGenerator
              framed={false}
              showHeader={false}
              showGeneratorForm={shareServerFormOpen}
            />
          </div>
        </div>
      ) : null}

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
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.d570c35a99',
                'Switch Server'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.b2290ed203',
                'Orca will close remote terminals and browser tabs from the current server before loading projects from the next server.'
              )}
            </DialogDescription>
          </DialogHeader>
          {pendingSwitchValue ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="text-muted-foreground">
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.05e0fc3ebf',
                  'Switch to'
                )}
              </div>
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
              {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
            </Button>
            <Button
              onClick={() => {
                const value = pendingSwitchValue
                if (!value) {
                  return
                }
                void switchToValue(value).then((switched) => {
                  if (switched && mountedRef.current) {
                    setPendingSwitchValue(null)
                  }
                })
              }}
              disabled={switchingValue !== null}
            >
              {switchingValue !== null ? <Loader2 className="animate-spin" /> : null}
              {translate('auto.components.settings.RuntimeEnvironmentsPane.d2e00809e4', 'Switch')}
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
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.bb90dd6487',
                'Remove Server'
              )}
            </DialogTitle>
            <DialogDescription>
              {removingActiveServer
                ? allowLocalRuntime
                  ? translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.9f7665a01b',
                      'Removing the active server first switches Orca back to Local desktop and closes remote terminals and browser tabs for that server.'
                    )
                  : translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.b2fda48c39',
                      'Removing the active server disconnects this browser and closes remote terminals and browser tabs for that server.'
                    )
                : translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.ed3e3f069d',
                    'This removes the saved server from Orca. It does not change the active server.'
                  )}
            </DialogDescription>
          </DialogHeader>
          {pendingRemove ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="truncate font-medium">{pendingRemove.name}</div>
              <div className="mt-0.5 truncate font-mono text-muted-foreground">
                {pendingRemove.endpoints[0]?.endpoint ??
                  translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.6ef71985da',
                    'No endpoint'
                  )}
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
              {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const environment = pendingRemove
                if (!environment) {
                  return
                }
                void removeEnvironment(environment).then((removed) => {
                  if (removed && mountedRef.current) {
                    setPendingRemove(null)
                  }
                })
              }}
              disabled={removingId !== null}
            >
              {removingId !== null ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {translate('auto.components.settings.RuntimeEnvironmentsPane.aeb26635d2', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SearchableSetting>
  )
}
