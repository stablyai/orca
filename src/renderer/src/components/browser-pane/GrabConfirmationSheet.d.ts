import type { BrowserGrabPayload } from '../../../../shared/browser-grab-types';
export declare function formatGrabPayloadAsText(payload: BrowserGrabPayload): string;
export default function GrabConfirmationSheet({ payload, onCopy, onCopyScreenshot, onAttach, onCancel }: {
    payload: BrowserGrabPayload;
    onCopy: () => void;
    onCopyScreenshot: (() => void) | null;
    onAttach: () => void;
    onCancel: () => void;
}): React.JSX.Element;
