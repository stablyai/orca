type BrowserAddressBarProps = {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onNavigate: (url: string) => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
};
export default function BrowserAddressBar({ value, onChange, onSubmit, onNavigate, inputRef }: BrowserAddressBarProps): React.ReactElement;
export {};
