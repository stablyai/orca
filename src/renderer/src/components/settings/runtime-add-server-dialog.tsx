import { useState } from 'react'
import type { RuntimeEdgeAuthHeader } from '../../../../shared/runtime-edge-auth-types'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import {
  endpointAuthOrigin,
  normalizeEndpointAuthHeaders
} from '../../../../shared/network/endpoint-auth-headers'
import { RuntimeEdgeAuthFields, newRuntimeEdgeAuthRow } from './runtime-edge-auth-fields'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { RuntimeHostAccessForm } from './RuntimeHostAccessForm'
import type { RuntimeHostAccessFailure } from './RuntimeHostAccessFailureAlert'

type RuntimeAddServerDialogProps = {
  open: boolean
  name: string
  accessLink: string
  busy: boolean
  failure: RuntimeHostAccessFailure | null
  onNameChange: (value: string) => void
  onAccessLinkChange: (value: string) => void
  onClose: () => void
  retryCredentials?: boolean
  onSubmit: (allowLoopback: boolean, headers?: RuntimeEdgeAuthHeader[]) => void
}

export function RuntimeAddServerDialog({
  open,
  name,
  accessLink,
  busy,
  failure,
  onNameChange,
  onAccessLinkChange,
  onClose,
  retryCredentials,
  onSubmit
}: RuntimeAddServerDialogProps): React.JSX.Element {
  const takenNames = useAppStore((state) => state.runtimeEnvironments)
  const parsed = parseHostAccessLink(accessLink)
  const credentialBindingKey = parsed.ok
    ? JSON.stringify([
        endpointAuthOrigin(parsed.value.pairing.endpoint),
        parsed.value.pairing.publicKeyB64
      ])
    : 'invalid'
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent scrollable>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.serverList.addTitle', 'Add server')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.serverList.addDescriptionShort',
              'Paste the access link from Share this computer on the other machine.'
            )}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <RuntimeAddServerForm
            key={credentialBindingKey}
            name={name}
            retryCredentials={retryCredentials}
            takenNames={takenNames}
            accessLink={accessLink}
            busy={busy}
            failure={failure}
            onNameChange={onNameChange}
            onAccessLinkChange={onAccessLinkChange}
            onCancel={onClose}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function RuntimeAddServerForm(
  props: React.ComponentProps<typeof RuntimeHostAccessForm> & {
    onSubmit: (allowLoopback: boolean, headers?: RuntimeEdgeAuthHeader[]) => void
  }
): React.JSX.Element {
  const [rows, setRows] = useState(() => [newRuntimeEdgeAuthRow()])
  const parsed = parseHostAccessLink(props.accessLink)
  const secure =
    parsed.ok &&
    parsed.value.pairing.endpoint.toLowerCase().startsWith('wss://') &&
    Boolean(window.api.runtimeEnvironments.saveEdgeAuth)
  const normalized = normalizeEndpointAuthHeaders(rows)
  return (
    <RuntimeHostAccessForm
      {...props}
      edgeAuthFields={
        secure ? (
          <RuntimeEdgeAuthFields rows={rows} onChange={setRows} disabled={props.busy} />
        ) : null
      }
      edgeAuthValid={!secure || normalized.ok}
      onSubmit={(allowLoopback) =>
        props.onSubmit(
          allowLoopback,
          secure ? rows.map(({ name, value }) => ({ name, value })) : undefined
        )
      }
    />
  )
}
