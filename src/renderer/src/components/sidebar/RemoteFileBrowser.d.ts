import React from 'react';
type RemoteFileBrowserProps = {
    targetId: string;
    initialPath?: string;
    onSelect: (path: string) => void;
    onCancel: () => void;
};
export declare function RemoteFileBrowser({ targetId, initialPath, onSelect, onCancel }: RemoteFileBrowserProps): React.JSX.Element;
export {};
