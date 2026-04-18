export type ZoomTargetType = 'ui' | 'editor' | 'terminal';
export type ZoomLevelChangedEventDetail = {
    type: ZoomTargetType;
    percent: number;
};
export declare const ZOOM_LEVEL_CHANGED_EVENT = "orca:zoom-level-changed";
export declare function dispatchZoomLevelChanged(type: ZoomTargetType, percent: number): void;
