import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager';
import type { IDisposable } from '@xterm/xterm';
import type { PtyConnectionDeps } from './pty-connection-types';
export declare function connectPanePty(pane: ManagedPane, manager: PaneManager, deps: PtyConnectionDeps): IDisposable;
