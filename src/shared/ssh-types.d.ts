export type SshTarget = {
    id: string;
    label: string;
    /** Host alias to resolve through OpenSSH config (ssh -G). */
    configHost?: string;
    host: string;
    port: number;
    username: string;
    /** Path to private key file, if using key-based auth. */
    identityFile?: string;
    /** ProxyCommand from SSH config, if any. */
    proxyCommand?: string;
    /** Jump host (ProxyJump), if any. */
    jumpHost?: string;
};
export type SshConnectionStatus = 'disconnected' | 'connecting' | 'auth-failed' | 'deploying-relay' | 'connected' | 'reconnecting' | 'reconnection-failed' | 'error';
export type SshConnectionState = {
    targetId: string;
    status: SshConnectionStatus;
    error: string | null;
    /** Number of reconnection attempts since last disconnect. */
    reconnectAttempt: number;
};
