import React, { useCallback, useRef, useState } from 'react'
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
import { translate } from '@/i18n/i18n'

export function SshPassphraseDialog(): React.JSX.Element | null {
  const request = useAppStore((s) => s.sshCredentialQueue[0] ?? null)
  const targetLabels = useAppStore((s) => s.sshTargetLabels)
  const removeRequest = useAppStore((s) => s.removeSshCredentialRequest)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusFrameRef = useRef<number | null>(null)

  const open = request !== null

  const requestId = request?.requestId

  // Reset before paint so new requests cannot flash the previous credential.
  const [prevRequestId, setPrevRequestId] = useState(requestId)
  if (requestId !== prevRequestId) {
    setPrevRequestId(requestId)
    if (requestId) {
      setValue('')
      setSubmitting(false)
    }
  }

  // Ref-owned focus frames avoid passive request effects and cancel on request/input replacement.
  const setInputRef = useCallback(
    (input: HTMLInputElement | null): void => {
      inputRef.current = input
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current)
        focusFrameRef.current = null
      }
      if (!input || !requestId) {
        return
      }
      focusFrameRef.current = requestAnimationFrame(() => {
        focusFrameRef.current = null
        if (inputRef.current === input) {
          input.focus()
        }
      })
    },
    [requestId]
  )

  const handleSubmit = useCallback(async () => {
    // Keyboard-interactive prompts may accept empty Enter for MFA; passwords/passphrases cannot.
    if (!request || (!value && request.kind !== 'keyboard-interactive')) {
      return
    }
    setSubmitting(true)
    try {
      await window.api.ssh.submitCredential({ requestId: request.requestId, value })
      removeRequest(request.requestId)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.SshPassphraseDialog.b8e88fd0de',
              'Failed to submit SSH credential'
            )
      )
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
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.settings.SshPassphraseDialog.c55f105262',
                'Failed to cancel SSH credential request'
              )
        )
        setSubmitting(false)
      }
    }
  }, [request, removeRequest])

  if (!request) {
    return null
  }

  const label = targetLabels.get(request.targetId) ?? request.targetId
  const isPassword = request.kind === 'password'
  const isKeyboardInteractive = request.kind === 'keyboard-interactive'

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && void handleCancel()}>
      {/* Credential prompts must cover existing menus/popovers, whose z-order exceeds the default dialog. */}
      <DialogContent
        showCloseButton={false}
        overlayClassName="!z-[140]"
        className="!z-[150] max-w-[360px]"
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isKeyboardInteractive
              ? translate(
                  'auto.components.settings.SshPassphraseDialog.a21f9e74c0',
                  'SSH Verification'
                )
              : isPassword
                ? translate(
                    'auto.components.settings.SshPassphraseDialog.106bd57f4a',
                    'SSH Password'
                  )
                : translate(
                    'auto.components.settings.SshPassphraseDialog.1f3dde805d',
                    'SSH Key Passphrase'
                  )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isKeyboardInteractive ? (
              <>
                {translate(
                  'auto.components.settings.SshPassphraseDialog.981352fb42',
                  'Complete the verification challenge for'
                )}{' '}
                <span className="font-medium">{label}</span>
              </>
            ) : isPassword ? (
              <>
                {translate(
                  'auto.components.settings.SshPassphraseDialog.dbf9b6f2d0',
                  'Enter the password for'
                )}{' '}
                <span className="font-medium">{label}</span>
              </>
            ) : (
              <>
                {translate(
                  'auto.components.settings.SshPassphraseDialog.ce4fdf7914',
                  'Enter the passphrase for'
                )}{' '}
                <span className="font-medium">{label}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div>
          <label
            htmlFor="ssh-credential-input"
            className="text-[11px] font-medium text-muted-foreground mb-1 block whitespace-pre-wrap break-words"
          >
            {isKeyboardInteractive
              ? request.detail
              : isPassword
                ? translate(
                    'auto.components.settings.SshPassphraseDialog.cab3d5f5a5',
                    'Password for {{value0}}',
                    { value0: request.detail }
                  )
                : translate(
                    'auto.components.settings.SshPassphraseDialog.8a349e3fac',
                    'Passphrase for {{value0}}',
                    { value0: request.detail }
                  )}
          </label>
          <Input
            id="ssh-credential-input"
            ref={setInputRef}
            type={isKeyboardInteractive && request.echo ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSubmit()
              }
            }}
            placeholder={
              isKeyboardInteractive
                ? translate(
                    'auto.components.settings.SshPassphraseDialog.456516603b',
                    'Enter response'
                  )
                : isPassword
                  ? translate(
                      'auto.components.settings.SshPassphraseDialog.abaa0dc653',
                      'Enter password'
                    )
                  : translate(
                      'auto.components.settings.SshPassphraseDialog.c3ce71aad6',
                      'Enter passphrase'
                    )
            }
            className="h-8 text-sm"
            disabled={submitting}
          />
        </div>
        <DialogFooter className="mt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCancel()}
            disabled={submitting}
          >
            {translate('auto.components.settings.SshPassphraseDialog.d5a234456f', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={(!value && !isKeyboardInteractive) || submitting}
          >
            {isKeyboardInteractive
              ? translate('auto.components.settings.SshPassphraseDialog.c624f64b86', 'Continue')
              : isPassword
                ? translate('auto.components.settings.SshPassphraseDialog.bec2c1318f', 'Connect')
                : translate('auto.components.settings.SshPassphraseDialog.405066423c', 'Unlock')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
