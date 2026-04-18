/**
 * Step views for AddRepoDialog: Clone, Remote, and Setup.
 *
 * Why extracted: keeps AddRepoDialog.tsx under the 400-line oxlint limit
 * by moving the presentational JSX for each wizard step into separate components
 * while the parent retains all state and handlers.
 */
import React from 'react';
import type { Repo } from '../../../../shared/types';
import type { SshTarget, SshConnectionState } from '../../../../shared/ssh-types';
export declare function useRemoteRepo(fetchWorktrees: (repoId: string) => Promise<void>, setStep: (step: 'add' | 'clone' | 'remote' | 'setup') => void, setAddedRepo: (repo: Repo | null) => void, closeModal: () => void): {
    sshTargets: (SshTarget & {
        state?: SshConnectionState;
    })[];
    selectedTargetId: string | null;
    remotePath: string;
    remoteError: string | null;
    isAddingRemote: boolean;
    setSelectedTargetId: React.Dispatch<React.SetStateAction<string | null>>;
    setRemotePath: React.Dispatch<React.SetStateAction<string>>;
    setRemoteError: React.Dispatch<React.SetStateAction<string | null>>;
    resetRemoteState: () => void;
    handleOpenRemoteStep: () => Promise<void>;
    handleAddRemoteRepo: () => Promise<void>;
};
type RemoteStepProps = {
    sshTargets: (SshTarget & {
        state?: SshConnectionState;
    })[];
    selectedTargetId: string | null;
    remotePath: string;
    remoteError: string | null;
    isAddingRemote: boolean;
    onSelectTarget: (id: string) => void;
    onRemotePathChange: (value: string) => void;
    onAdd: () => void;
};
export declare function RemoteStep({ sshTargets, selectedTargetId, remotePath, remoteError, isAddingRemote, onSelectTarget, onRemotePathChange, onAdd }: RemoteStepProps): React.JSX.Element;
type CloneStepProps = {
    cloneUrl: string;
    cloneDestination: string;
    cloneError: string | null;
    cloneProgress: {
        phase: string;
        percent: number;
    } | null;
    isCloning: boolean;
    onUrlChange: (value: string) => void;
    onDestChange: (value: string) => void;
    onPickDestination: () => void;
    onClone: () => void;
};
export declare function CloneStep({ cloneUrl, cloneDestination, cloneError, cloneProgress, isCloning, onUrlChange, onDestChange, onPickDestination, onClone }: CloneStepProps): React.JSX.Element;
export {};
