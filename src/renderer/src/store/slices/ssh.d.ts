import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { SshConnectionState } from '../../../../shared/ssh-types';
export type SshCredentialRequest = {
    requestId: string;
    targetId: string;
    kind: 'passphrase' | 'password';
    detail: string;
};
export type SshSlice = {
    sshConnectionStates: Map<string, SshConnectionState>;
    /** Maps target IDs to their user-facing labels. Populated during hydration
     * so components can look up labels without per-component IPC calls. */
    sshTargetLabels: Map<string, string>;
    sshCredentialQueue: SshCredentialRequest[];
    setSshConnectionState: (targetId: string, state: SshConnectionState) => void;
    setSshTargetLabels: (labels: Map<string, string>) => void;
    enqueueSshCredentialRequest: (req: SshCredentialRequest) => void;
    removeSshCredentialRequest: (requestId: string) => void;
};
export declare const createSshSlice: StateCreator<AppState, [], [], SshSlice>;
