// One English table for Remote Orca Server pairing save failures: main builds the wire `message`, the renderer translates by code.
export const REMOTE_SERVER_PAIRING_FAILURE_COPY = {
  invalidPairingCode:
    'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.',
  selfPairingCode:
    'This pairing code is for this Orca itself. Generate the code on the other computer instead.',
  managedDeployment:
    'Orca runs this server on an SSH host for you; its pairing cannot be replaced or removed here. To decommission it, run `orca environment stop --environment <name> --yes` or use Settings > Orca on your SSH hosts; for a host that is gone, run `orca environment forget --environment <name> --yes`.',
  sshAccessChangePending:
    "This server's SSH access change didn't finish. Retry or cancel it under Settings > Remote Orca Servers > SSH access for paired servers before replacing its pairing or removing it.",
  sshAccessLinked:
    "Unlink this server's SSH access under Settings > Remote Orca Servers > SSH access for paired servers before replacing its pairing or removing it.",
  alreadyPairedCloudWorkspace:
    'This server is already paired as "{{name}}". It belongs to a cloud workspace, which pairs it again when it resumes.',
  alreadyPairedCloudIdentity:
    'This server is already paired as "{{name}}". The cloud workspace\'s server reuses that server\'s identity, so it was not saved.',
  alreadyPairedWslHost:
    'This server is already paired as "{{name}}". Orca manages it as a WSL host, so its pairing cannot be replaced here.',
  alreadyPairedManagedDeployment:
    'This server is already paired as "{{name}}". Orca runs this server on an SSH host for you; its pairing cannot be replaced or removed here. To decommission it, run `orca environment stop --environment <name> --yes` or use Settings > Orca on your SSH hosts; for a host that is gone, run `orca environment forget --environment <name> --yes`.',
  alreadyPairedSshAccessChangePending:
    'This server is already paired as "{{name}}". This server\'s SSH access change didn\'t finish. Retry or cancel it under Settings > Remote Orca Servers > SSH access for paired servers before replacing its pairing or removing it.',
  alreadyPairedSshAccessLinked:
    'This server is already paired as "{{name}}". Unlink this server\'s SSH access under Settings > Remote Orca Servers > SSH access for paired servers before replacing its pairing or removing it.',
  alreadyPairedAddAgain:
    'This server is already paired as "{{name}}". To update its connection, add it again under Settings > Remote Orca Servers.',
  alreadyPairedUnreadable:
    'This server is already paired as "{{name}}", whose saved settings this version of Orca cannot read.',
  nameTaken: 'A server named "{{name}}" already exists.',
  idNeedsNewerOrca:
    'A server with this id already exists in a format that needs a newer version of Orca.',
  hostSaveFailed:
    'Orca verified the host but could not save it. Check local settings storage and try again.',
  repairSaveFailed:
    'Orca verified the server but could not save the new pairing. Check local settings storage and try again.',
  repairCloudWorkspace:
    'This server belongs to a cloud workspace, which pairs it again when it resumes.'
} as const

export type RemoteServerPairingFailureCode = keyof typeof REMOTE_SERVER_PAIRING_FAILURE_COPY

export type RemoteServerPairingFailureFields = {
  errorCode: RemoteServerPairingFailureCode
  errorParams?: { name: string }
}

const ALREADY_PAIRED_GUARD_CODES: Partial<
  Record<RemoteServerPairingFailureCode, RemoteServerPairingFailureCode>
> = {
  managedDeployment: 'alreadyPairedManagedDeployment',
  sshAccessChangePending: 'alreadyPairedSshAccessChangePending',
  sshAccessLinked: 'alreadyPairedSshAccessLinked'
}

/** The "already paired as" form of an SSH-access guard, or null for any other code. */
export function alreadyPairedGuardCode(
  code: RemoteServerPairingFailureCode
): RemoteServerPairingFailureCode | null {
  return ALREADY_PAIRED_GUARD_CODES[code] ?? null
}

export function remoteServerPairingFailureText(
  code: RemoteServerPairingFailureCode,
  params?: { name: string }
): string {
  return REMOTE_SERVER_PAIRING_FAILURE_COPY[code].replace('{{name}}', () => params?.name ?? '')
}
