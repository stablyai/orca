import type { SshConnectionStatus } from '../../../../shared/ssh-types';
type SshDisconnectedDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    targetId: string;
    targetLabel: string;
    status: SshConnectionStatus;
};
export declare function SshDisconnectedDialog({ open, onOpenChange, targetId, targetLabel, status }: SshDisconnectedDialogProps): React.JSX.Element;
export {};
