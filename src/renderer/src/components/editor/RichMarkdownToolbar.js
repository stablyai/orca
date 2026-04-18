import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEditorState } from '@tiptap/react';
import { Heading1, Heading2, Heading3, ImageIcon, Link as LinkIcon, List, ListOrdered, ListTodo, Pilcrow, Quote } from 'lucide-react';
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton';
function Separator() {
    return _jsx("div", { className: "rich-markdown-toolbar-separator" });
}
export function RichMarkdownToolbar({ editor, onToggleLink, onImagePick }) {
    // Why: the editor object reference is stable across transactions, so passing
    // it as a prop alone won't re-render this component when the selection moves.
    // useEditorState subscribes to editor transactions and returns derived state,
    // triggering a re-render only when the active formatting actually changes.
    const active = useEditorState({
        editor,
        selector: (ctx) => {
            const ed = ctx.editor;
            if (!ed) {
                return null;
            }
            return {
                paragraph: ed.isActive('paragraph'),
                h1: ed.isActive('heading', { level: 1 }),
                h2: ed.isActive('heading', { level: 2 }),
                h3: ed.isActive('heading', { level: 3 }),
                bold: ed.isActive('bold'),
                italic: ed.isActive('italic'),
                strike: ed.isActive('strike'),
                bulletList: ed.isActive('bulletList'),
                orderedList: ed.isActive('orderedList'),
                taskList: ed.isActive('taskList'),
                blockquote: ed.isActive('blockquote'),
                link: ed.isActive('link')
            };
        }
    });
    return (_jsxs("div", { className: "rich-markdown-editor-toolbar", children: [_jsx(RichMarkdownToolbarButton, { active: active?.paragraph ?? false, label: "Body text", onClick: () => editor?.chain().focus().setParagraph().run(), children: _jsx(Pilcrow, { className: "size-3.5" }) }), _jsx(RichMarkdownToolbarButton, { active: active?.h1 ?? false, label: "Heading 1", onClick: () => editor?.chain().focus().toggleHeading({ level: 1 }).run(), children: _jsx(Heading1, { className: "size-3.5" }) }), _jsx(RichMarkdownToolbarButton, { active: active?.h2 ?? false, label: "Heading 2", onClick: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), children: _jsx(Heading2, { className: "size-3.5" }) }), _jsx(RichMarkdownToolbarButton, { active: active?.h3 ?? false, label: "Heading 3", onClick: () => editor?.chain().focus().toggleHeading({ level: 3 }).run(), children: _jsx(Heading3, { className: "size-3.5" }) }), _jsx(Separator, {}), _jsx(RichMarkdownToolbarButton, { active: active?.bold ?? false, label: "Bold", onClick: () => editor?.chain().focus().toggleBold().run(), children: "B" }), _jsx(RichMarkdownToolbarButton, { active: active?.italic ?? false, label: "Italic", onClick: () => editor?.chain().focus().toggleItalic().run(), children: "I" }), _jsx(RichMarkdownToolbarButton, { active: active?.strike ?? false, label: "Strike", onClick: () => editor?.chain().focus().toggleStrike().run(), children: "S" }), _jsx(Separator, {}), _jsx(RichMarkdownToolbarButton, { active: active?.bulletList ?? false, label: "Bullet list", onClick: () => editor?.chain().focus().toggleBulletList().run(), children: _jsx(List, { className: "size-3.5" }) }), _jsx(RichMarkdownToolbarButton, { active: active?.orderedList ?? false, label: "Numbered list", onClick: () => editor?.chain().focus().toggleOrderedList().run(), children: _jsx(ListOrdered, { className: "size-3.5" }) }), _jsx(RichMarkdownToolbarButton, { active: active?.taskList ?? false, label: "Checklist", onClick: () => editor?.chain().focus().toggleTaskList().run(), children: _jsx(ListTodo, { className: "size-3.5" }) }), _jsx(Separator, {}), _jsx(RichMarkdownToolbarButton, { active: active?.blockquote ?? false, label: "Quote", onClick: () => editor?.chain().focus().toggleBlockquote().run(), children: _jsx(Quote, { className: "size-3.5" }) }), _jsx(RichMarkdownToolbarButton, { active: active?.link ?? false, label: "Link", onClick: onToggleLink, children: _jsx(LinkIcon, { className: "size-3.5" }) }), _jsx(RichMarkdownToolbarButton, { active: false, label: "Image", onClick: onImagePick, children: _jsx(ImageIcon, { className: "size-3.5" }) })] }));
}
