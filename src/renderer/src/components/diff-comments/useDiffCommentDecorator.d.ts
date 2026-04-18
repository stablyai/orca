import type { editor as monacoEditor } from 'monaco-editor';
import type { DiffComment } from '../../../../shared/types';
type DecoratorArgs = {
    editor: monacoEditor.ICodeEditor | null;
    filePath: string;
    worktreeId: string;
    comments: DiffComment[];
    onAddCommentClick: (args: {
        lineNumber: number;
        top: number;
    }) => void;
    onDeleteComment: (commentId: string) => void;
};
export declare function useDiffCommentDecorator({ editor, filePath, worktreeId, comments, onAddCommentClick, onDeleteComment }: DecoratorArgs): void;
export {};
