type EditableTargetLike = {
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
};
export declare function isEditableKeyboardTarget(target: EventTarget | EditableTargetLike | null): boolean;
export {};
