import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useState } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { Copy, Check } from 'lucide-react';
import { useAppStore } from '@/store';
import MermaidBlock from './MermaidBlock';
/**
 * Common languages shown in the selector. The user can also type a language
 * name directly in the markdown fence (```rust) and it will be preserved —
 * this list is just for quick picking in the UI.
 */
const LANGUAGES = [
    { value: '', label: 'Plain text' },
    { value: 'bash', label: 'Bash' },
    { value: 'c', label: 'C' },
    { value: 'cpp', label: 'C++' },
    { value: 'css', label: 'CSS' },
    { value: 'diff', label: 'Diff' },
    { value: 'go', label: 'Go' },
    { value: 'graphql', label: 'GraphQL' },
    { value: 'html', label: 'HTML' },
    { value: 'java', label: 'Java' },
    { value: 'javascript', label: 'JavaScript' },
    { value: 'json', label: 'JSON' },
    { value: 'kotlin', label: 'Kotlin' },
    { value: 'markdown', label: 'Markdown' },
    { value: 'mermaid', label: 'Mermaid' },
    { value: 'python', label: 'Python' },
    { value: 'ruby', label: 'Ruby' },
    { value: 'rust', label: 'Rust' },
    { value: 'scss', label: 'SCSS' },
    { value: 'shell', label: 'Shell' },
    { value: 'sql', label: 'SQL' },
    { value: 'swift', label: 'Swift' },
    { value: 'typescript', label: 'TypeScript' },
    { value: 'xml', label: 'XML' },
    { value: 'yaml', label: 'YAML' }
];
export function RichMarkdownCodeBlock({ node, updateAttributes }) {
    const language = node.attrs.language || '';
    const [copied, setCopied] = useState(false);
    const settings = useAppStore((s) => s.settings);
    const isDark = settings?.theme === 'dark' ||
        (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const isMermaid = language === 'mermaid';
    const onChange = useCallback((e) => {
        updateAttributes({ language: e.target.value });
    }, [updateAttributes]);
    const handleCopy = useCallback((e) => {
        e.stopPropagation();
        const text = node.textContent;
        void window.api.ui
            .writeClipboardText(text)
            .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        })
            .catch(() => {
            // Silently swallow clipboard write failures (e.g. permission denied).
        });
    }, [node]);
    return (_jsxs(NodeViewWrapper, { className: "rich-markdown-code-block-wrapper", children: [_jsxs("select", { className: "rich-markdown-code-block-lang", contentEditable: false, value: language, onChange: onChange, children: [LANGUAGES.map((lang) => (_jsx("option", { value: lang.value, children: lang.label }, lang.value))), language && !LANGUAGES.some((l) => l.value === language) ? (_jsx("option", { value: language, children: language })) : null] }), _jsx("button", { type: "button", className: "code-block-copy-btn", contentEditable: false, onClick: handleCopy, "aria-label": "Copy code", title: "Copy code", children: copied ? (_jsxs(_Fragment, { children: [_jsx(Check, { size: 14 }), _jsx("span", { className: "code-block-copy-label", children: "Copied" })] })) : (_jsx(Copy, { size: 14 })) }), _jsx(NodeViewContent, { as: "pre" }), isMermaid && node.textContent.trim() && (_jsx("div", { contentEditable: false, className: "mermaid-preview", children: _jsx(MermaidBlock, { content: node.textContent.trim(), isDark: isDark, htmlLabels: false }) }))] }));
}
