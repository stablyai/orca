import type { BrowserGrabPayload } from '../../../../shared/browser-grab-types';
export type GrabModeState = 'idle' | 'armed' | 'awaiting' | 'confirming' | 'error';
export type GrabModeHook = {
    state: GrabModeState;
    payload: BrowserGrabPayload | null;
    error: string | null;
    /** True when the user right-clicked to select, signalling the renderer
     *  should show the full action menu instead of auto-copying. */
    contextMenu: boolean;
    toggle: () => void;
    cancel: () => void;
    /** Called after Copy — re-arms grab for another pick. */
    rearm: () => void;
    /** Called after Attach to AI — exits grab mode entirely. */
    exit: () => void;
};
/**
 * Hook that drives the browser grab lifecycle for a single browser page.
 *
 * The state machine: idle → armed → awaiting → confirming → idle/armed
 *                                                        ↘ error → idle
 */
export declare function useGrabMode(browserPageId: string): GrabModeHook;
