type BrowserFindProps = {
    isOpen: boolean;
    onClose: () => void;
    webviewRef: React.RefObject<Electron.WebviewTag | null>;
};
export default function BrowserFind({ isOpen, onClose, webviewRef }: BrowserFindProps): React.JSX.Element | null;
export {};
