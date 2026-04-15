import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'

export function SshPassphraseDialog(): React.JSX.Element | null {
  const request = useAppStore((s) => s.sshCredentialQueue[0] ?? null)
  const targetLabels = useAppStore((s) => s.sshTargetLabels)
  const removeRequest = useAppStore((s) => s.removeSshCredentialRequest)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const open = request !== null

  const requestId = request?.requestId
  useEffect(() => {
    if (requestId) {
      setValue('')
      setSubmitting(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [requestId])

  const handleSubmit = useCallback(async () => {
    if (!request || !value) {
      return
    }
    setSubmitting(true)
    try {
      await window.api.ssh.submitCredential({ requestId: request.requestId, value })
      removeRequest(request.requestId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit SSH credential')
      setSubmitting(false)
    }
  }, [request, value, removeRequest])

  const handleCancel = useCallback(async () => {
    if (request) {
      setSubmitting(true)
      try {
        await window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
        removeRequest(request.requestId)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to cancel SSH credential request')
        setSubmitting(false)
      }
    }
  }, [request, removeRequest])

  if (!request) {
    return null
  }

  const label = targetLabels.get(request.targetId) ?? request.targetId
  const isPassword = request.kind === 'password'

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && void handleCancel()}>
      <DialogContent showCloseButton={false} className="max-w-[360px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isPassword ? 'SSH Password' : 'SSH Key Passphrase'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isPassword ? (
              <>
                Enter the password for <span className="font-medium">{label}</span>
              </>
            ) : (
              <>
                Enter the passphrase for <span className="font-medium">{label}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div>
          <label
            htmlFor="ssh-credential-input"
            className="text-[11px] font-medium text-muted-foreground mb-1 block"
          >
            {isPassword ? `Password for ${request.detail}` : `Passphrase for ${request.detail}`}
          </label>
          <Input
            id="ssh-credential-input"
            ref={inputRef}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSubmit()
              }
            }}
            placeholder={isPassword ? 'Enter password' : 'Enter passphrase'}
            className="h-8 text-sm"
            disabled={submitting}
          />
        </div>
        <DialogFooter className="mt-1">
          <Button variant="outline" size="sm" onClick={() => void handleCancel()} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} disabled={!value || submitting}>
            {isPassword ? 'Connect' : 'Unlock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
