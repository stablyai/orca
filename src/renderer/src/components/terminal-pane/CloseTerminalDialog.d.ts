export default function CloseTerminalDialog({ open, onCancel, onConfirm }: {
    open: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}): React.JSX.Element;
