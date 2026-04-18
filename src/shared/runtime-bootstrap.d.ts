export type RuntimeTransportMetadata = {
    kind: 'unix';
    endpoint: string;
} | {
    kind: 'named-pipe';
    endpoint: string;
};
export type RuntimeMetadata = {
    runtimeId: string;
    pid: number;
    transport: RuntimeTransportMetadata | null;
    authToken: string | null;
    startedAt: number;
};
export declare function getRuntimeMetadataPath(userDataPath: string): string;
