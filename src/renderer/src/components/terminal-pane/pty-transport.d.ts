import type { PtyTransport, IpcPtyTransportOptions } from './pty-dispatcher';
export { ensurePtyDispatcher, getEagerPtyBufferHandle, registerEagerPtyBuffer, unregisterPtyDataHandlers } from './pty-dispatcher';
export type { EagerPtyHandle, PtyTransport, PtyConnectResult, IpcPtyTransportOptions } from './pty-dispatcher';
export { extractLastOscTitle } from '../../../../shared/agent-detection';
export declare function createIpcPtyTransport(opts?: IpcPtyTransportOptions): PtyTransport;
