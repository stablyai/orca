import React, { useCallback, useEffect, useRef, useState } from 'react'
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
  const request = useAppStore((s) => s.sshPassphraseQueue[0] ?? null)
  const targetLabels = useAppStore((s) => s.sshTargetLabels)
  const dequeue = useAppStore((s) => s.dequeueSshPassphraseRequest)
  const [passphrase, setPassphrase] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const open = request !== null

  const requestId = request?.requestId
  useEffect(() => {
    if (requestId) {
      setPassphrase('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [requestId])

  const handleSubmit = useCallback(() => {
    if (!request || !passphrase) {
      return
    }
    void window.api.ssh.submitPassphrase({ requestId: request.requestId, passphrase })
    dequeue()
  }, [request, passphrase, dequeue])

  const handleCancel = useCallback(() => {
    if (request) {
      void window.api.ssh.submitPassphrase({ requestId: request.requestId, passphrase: null })
    }
    dequeue()
  }, [request, dequeue])

  if (!request) {
    return null
  }

  const label = targetLabels.get(request.targetId) ?? request.targetId

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleCancel()}>
      <DialogContent showCloseButton={false} className="max-w-[360px]">
        <DialogHeader>
          <DialogTitle className="text-sm">SSH Key Passphrase</DialogTitle>
          <DialogDescription className="text-xs">
            Enter the passphrase for <span className="font-medium">{label}</span>
          </DialogDescription>
        </DialogHeader>
        <div>
          <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
            Passphrase for {request.keyPath}
          </label>
          <Input
            ref={inputRef}
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSubmit()
              }
            }}
            placeholder="Enter passphrase"
            className="h-8 text-sm"
          />
        </div>
        <DialogFooter className="mt-1">
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!passphrase}>
            Unlock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
