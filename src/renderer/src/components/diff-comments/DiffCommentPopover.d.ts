type Props = {
    lineNumber: number;
    top: number;
    onCancel: () => void;
    onSubmit: (body: string) => void;
};
export declare function DiffCommentPopover({ lineNumber, top, onCancel, onSubmit }: Props): React.JSX.Element;
export {};
