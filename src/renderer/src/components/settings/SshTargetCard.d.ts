import type { SshTarget, SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types';
export declare const STATUS_LABELS: Record<SshConnectionStatus, string>;
export declare function statusColor(status: SshConnectionStatus): string;
export declare function isConnecting(status: SshConnectionStatus): boolean;
type SshTargetCardProps = {
    target: SshTarget;
    state: SshConnectionState | undefined;
    testing: boolean;
    onConnect: (targetId: string) => void;
    onDisconnect: (targetId: string) => void;
    onTest: (targetId: string) => void;
    onEdit: (target: SshTarget) => void;
    onRemove: (targetId: string) => void;
};
export declare function SshTargetCard({ target, state, testing, onConnect, onDisconnect, onTest, onEdit, onRemove }: SshTargetCardProps): React.JSX.Element;
export {};
