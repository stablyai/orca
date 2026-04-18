import type { BrowserWorkspace as BrowserWorkspaceState } from '../../../../shared/types';
export declare function destroyPersistentWebview(browserTabId: string): void;
export default function BrowserPane({ browserTab, isActive }: {
    browserTab: BrowserWorkspaceState;
    isActive: boolean;
}): React.JSX.Element;
