import type { SearchAddon } from '@xterm/addon-search';
import type { SearchState } from '@/components/terminal-pane/keyboard-handlers';
type TerminalSearchProps = {
    isOpen: boolean;
    onClose: () => void;
    searchAddon: SearchAddon | null;
    searchStateRef: React.RefObject<SearchState>;
};
export default function TerminalSearch({ isOpen, onClose, searchAddon, searchStateRef }: TerminalSearchProps): React.JSX.Element | null;
export {};
