type BaseRefPickerProps = {
    repoId: string;
    currentBaseRef?: string;
    onSelect: (ref: string) => void;
    onUsePrimary?: () => void;
};
export declare function BaseRefPicker({ repoId, currentBaseRef, onSelect, onUsePrimary }: BaseRefPickerProps): React.JSX.Element;
export {};
