import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import type {
  BrowserProfileListResult,
  BrowserTabListResult,
  BrowserTabSetProfileResult
} from '../../../../../shared/runtime-browser-contracts'

const text = (key: string, fallback: string): string =>
  translate(`browser.clientHostedProfiles.${key}`, fallback)

/** Profile metadata and replacement belong to the page's runtime, never this desktop. */
export function useClientHostedBrowserProfiles(environmentId: string, page: string | null) {
  const mounted = useMountedRef()
  const request = useRef(0)
  const switching = useRef(false)
  const loadedPairingRevision = useRef<number | undefined>(undefined)
  const [profiles, setProfiles] = useState<BrowserProfileListResult['profiles']>([])
  const [current, setCurrent] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{
    id: string
    pairingRevision: number | undefined
  } | null>(null)
  const target = { kind: 'environment', environmentId } as const

  const load = async (): Promise<void> => {
    if (!page || switching.current) {
      return
    }
    const revision = ++request.current
    const pairingRevision = captureRuntimeEnvironmentRequestRevision(environmentId)
    setLoading(true)
    setCurrent(undefined)
    setError(null)
    try {
      const [list, selected] = await Promise.all([
        callRuntimeRpc<BrowserProfileListResult>(target, 'browser.profileList', undefined, {
          expectedEnvironmentPairingRevision: pairingRevision
        }),
        callRuntimeRpc<BrowserTabListResult>(target, 'browser.tabList', undefined, {
          expectedEnvironmentPairingRevision: pairingRevision
        })
      ])
      if (!mounted.current || revision !== request.current) {
        return
      }
      const activePage = selected.tabs.find((tab) => tab.browserPageId === page)
      if (!activePage) {
        throw new Error(
          text('pageMissing', 'This browser page is no longer available on the host.')
        )
      }
      loadedPairingRevision.current = pairingRevision
      setProfiles(list.profiles)
      setCurrent(activePage.profileId ?? 'default')
    } catch (cause) {
      if (mounted.current && revision === request.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : text('loadError', 'Could not load browser profiles.')
        )
      }
    } finally {
      if (mounted.current && revision === request.current) {
        setLoading(false)
      }
    }
  }

  const confirm = async (): Promise<void> => {
    if (!page || !pending || switching.current) {
      return
    }
    switching.current = true
    setBusy(true)
    setError(null)
    try {
      await callRuntimeRpc<BrowserTabSetProfileResult>(
        target,
        'browser.tabSetProfile',
        {
          page,
          profileId: pending.id
        },
        { expectedEnvironmentPairingRevision: pending.pairingRevision }
      )
      if (mounted.current) {
        setPending(null)
        switching.current = false
        void load()
      }
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : text('switchError', 'Could not switch browser profiles.')
        )
      }
    } finally {
      switching.current = false
      if (mounted.current) {
        setBusy(false)
        // A timed-out switch may still finish on the host; never restore a guest here.
      }
    }
  }

  return {
    load,
    items: (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{text('label', 'Browser profile')}</DropdownMenuLabel>
        {!page && (
          <DropdownMenuItem disabled>
            {text('waiting', 'Waiting for browser host…')}
          </DropdownMenuItem>
        )}
        {loading && (
          <DropdownMenuItem disabled>{text('loading', 'Loading profiles…')}</DropdownMenuItem>
        )}
        {busy && (
          <DropdownMenuItem disabled>{text('switching', 'Switching profile…')}</DropdownMenuItem>
        )}
        {error && !pending && (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              void load()
            }}
          >
            {text('retry', 'Could not load profiles. Retry')}
          </DropdownMenuItem>
        )}
        {!loading && current !== undefined && profiles.length === 0 && (
          <DropdownMenuItem disabled>
            {text('empty', 'No browser profiles available')}
          </DropdownMenuItem>
        )}
        {!loading && current !== undefined && (
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(id) => {
              if (id !== current) {
                setPending({ id, pairingRevision: loadedPairingRevision.current })
              }
            }}
          >
            {profiles.map((profile) => (
              <DropdownMenuRadioItem key={profile.id} value={profile.id} disabled={busy}>
                {profile.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </>
    ),
    dialog: (
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPending(null)
            setError(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{text('confirmTitle', 'Switch Profile')}</DialogTitle>
            <DialogDescription>
              {text(
                'confirmDescription',
                'Switching profiles will reload this page. Any unsaved form data will be lost.'
              )}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setPending(null)
                setError(null)
              }}
            >
              {text('cancel', 'Cancel')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void confirm()}>
              {busy ? text('pending', 'Switching…') : text('confirm', 'Switch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
}
