import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from '@/lib/utils';
import { runSlashCommand } from './rich-markdown-commands';
export function RichMarkdownSlashMenu({ editor, slashMenu, filteredCommands, selectedIndex, onImagePick }) {
    return (_jsx("div", { className: "rich-markdown-slash-menu", style: { left: slashMenu.left, top: slashMenu.top }, role: "listbox", "aria-label": "Slash commands", children: filteredCommands.map((command, index) => {
            const Icon = command.icon;
            return (_jsxs("button", { type: "button", className: cn('rich-markdown-slash-item', index === selectedIndex && 'is-active'), onMouseDown: (event) => event.preventDefault(), onClick: () => editor && runSlashCommand(editor, slashMenu, command, onImagePick), children: [_jsx("span", { className: "rich-markdown-slash-icon", children: _jsx(Icon, { className: "size-3.5" }) }), _jsxs("span", { className: "flex min-w-0 flex-1 flex-col items-start", children: [_jsx("span", { className: "truncate text-sm font-medium", children: command.label }), _jsx("span", { className: "truncate text-xs text-muted-foreground", children: command.description })] })] }, command.id));
        }) }));
}
